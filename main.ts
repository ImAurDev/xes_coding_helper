import { Debug, Info } from "./lib/info.ts";
import { getPort } from "./lib/ports.ts";

const VERSION = "2.13.0";
const router = new Map<
    string,
    (req: Request) => Promise<Response> | Response
>();
const stdinText = new Map<number, string>();

const jsonResponse = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data, null, 2), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "access-control-allow-origin": "*",
        },
    });

router.set("GET@/ping", () => jsonResponse({ data: { auto: true } }));
router.set("GET@/version", () => jsonResponse({ data: { version: VERSION } }));

router.set("POST@/path", async (req) => {
    try {
        const { id } = await req.json();
        if (!id) return jsonResponse({ message: "缺少 id" }, 400);

        const port = await getPort();
        return jsonResponse({ path: `http://127.0.0.1:${port + 4}/${id}` });
    } catch {
        return jsonResponse({ message: "请求格式错误" }, 400);
    }
});

const toBase64 = (str: string): string =>
    btoa(
        new TextEncoder().encode(str).reduce(
            (acc, byte) => acc + String.fromCharCode(byte),
            "",
        ),
    );

interface PythonProcess {
    command: Deno.ChildProcess;
    stdin: WritableStreamDefaultWriter<Uint8Array>;
    cleanup: () => Promise<void>;
    socket: WebSocket;
    processId: string;
    isFinished: boolean;
}

const activeProcesses = new Map<string, PythonProcess>();
const generateId = () =>
    `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

const END_SIGNALS = [
    "7eyJUeXBlIjogInJ1bkluZm8iLCAiSW5mbyI6ICJcclxuXHJcblx1NGVlM1x1NzgwMVx1OGZkMFx1ODg0Y1x1N2VkM1x1Njc1ZiJ9",
    "7eyJUeXBlIjogInNpZ25hbCIsICJJbmZvIjogIntcIm5ld1wiOiBbXSwgXCJkZWxcIjogW10sIFwibW9kXCI6IFtdLCBcImRpcl9kZWxcIjogW10sIFwiZGlyX25ld1wiOiBbXSwgXCJ0eXBlXCI6IFwiY2hhbmdlZFwifSJ9",
];

const sendOutput = (socket: WebSocket, message: string) => {
    socket.send("1" + toBase64(message));
};

const sendEndSignals = (socket: WebSocket) => {
  END_SIGNALS.forEach((sig, i) => {
    console.log(`[SEND-END] 第${i + 1}条`, sig);
    socket.send(sig);
  });
};

const cleanupProcess = async (process: PythonProcess) => {
    try {
        process.stdin.releaseLock();
        process.command.kill("SIGTERM");
        activeProcesses.delete(process.processId);
    } catch {}
};

const runPythonCode = async (
    code: string,
    processId: string,
    socket: WebSocket,
) => {
    if (!code.trim()) {
        sendOutput(socket, "代码不能为空！");
        return;
    }

    try {
        const tempDir = await Deno.makeTempDir();
        const tempFile = `${tempDir}/code.py`;
        await Deno.writeTextFile(tempFile, code);

        const command = new Deno.Command("python", {
            args: ["-u", tempFile],
            stdin: "piped",
            stdout: "piped",
            stderr: "piped",
        });

        const child = command.spawn();
        const stdin = child.stdin.getWriter();

        const process: PythonProcess = {
            command: child,
            stdin,
            socket,
            processId,
            isFinished: false,
            cleanup: async () => {
                await cleanupProcess(process);
                try {
                    await Deno.remove(tempFile);
                    await Deno.remove(tempDir);
                } catch {}
            },
        };

        activeProcesses.set(processId, process);

        const handleStream = async (stream: ReadableStream<Uint8Array>) => {
            const reader = stream.getReader();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value) {
                        sendOutput(socket, new TextDecoder().decode(value));
                    }
                }
            } finally {
                reader.releaseLock();
            }
        };

        Promise.all([
            handleStream(child.stdout),
            handleStream(child.stderr),
        ]);

        child.status.finally(async () => {
            await process.cleanup();
            sendEndSignals(socket);
        });
    } catch (error) {
        sendOutput(socket, `启动错误: ${error.message}`);
        sendEndSignals(socket);
    }
};

const handleHttp = (req: Request): Response | Promise<Response> => {
    const url = new URL(req.url);
    const handler = router.get(`${req.method}@${url.pathname}`);

    return handler?.(req) ?? new Response(
        "404",
        { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
};

const handleWebSocket = (req: Request): Response => {
    if (req.headers.get("upgrade") !== "websocket") {
        return new Response("只支持WebSocket连接", { status: 400 });
    }

    const { socket, response } = Deno.upgradeWebSocket(req, {
        protocol: "webtty",
    });
    let currentProcessId: string | null = null;

    socket.onopen = () => Debug("WebSocket连接已建立");

    socket.onmessage = async (event) => {
        const data = event.data.toString();

        if (data.startsWith("1")) {
            const process = currentProcessId &&
                activeProcesses.get(currentProcessId);
            if (process && !process.isFinished) {
                socket.send("1" + toBase64(data.slice(1)));
                await process.stdin.write(
                    new TextEncoder().encode(data.slice(1)),
                );
            }
            return;
        }

        if (data.startsWith("7")) {
            try {
                const jsonStr = data.slice(1);
                const message = JSON.parse(jsonStr);

                if (message.type === "conn" && message.handle === "close") {
                    if (currentProcessId) {
                        const process = activeProcesses.get(currentProcessId);
                        if (process) await process.cleanup();
                    }
                    sendEndSignals(socket);
                    return;
                }

                const extractPythonCode = (data: any): string => {
                    if (data.xml?.trim()) return String(data.xml);

                    const mainFile = data.tabsListData?.find(
                        (tab: any) =>
                            tab.name === "main.py" || tab.ext === "py",
                    );

                    return mainFile?.value?.trim() ||
                        mainFile?.content?.trim() || "";
                };

                const pythonCode = extractPythonCode(message).trim().replace(
                    /\\n/g,
                    "\n",
                );
                if (!pythonCode) return;

                if (currentProcessId) {
                    const oldProcess = activeProcesses.get(currentProcessId);
                    if (oldProcess) await oldProcess.cleanup();
                }

                currentProcessId = generateId();
                runPythonCode(pythonCode, currentProcessId, socket);
            } catch {
                sendEndSignals(socket);
            }
        }
    };

    socket.onclose = async () => {
        Debug("WebSocket连接已关闭");
        if (currentProcessId) {
            const process = activeProcesses.get(currentProcessId);
            if (process) await process.cleanup();
        }
    };

    socket.onerror = (ev) => {
        console.error("[ERROR] Websocket错误退出:", ev);
    };

    return response;
};

if (import.meta.main) {
    const basePort = await getPort();
    const httpPort = basePort;
    const wsPort = basePort + 1;

    Debug(`HTTP服务端口: ${httpPort}`);
    Debug(`WebSocket服务端口: ${wsPort}`);

    Deno.serve({ port: httpPort }, handleHttp);
    Deno.serve({ port: wsPort }, handleWebSocket);

    Info(`HTTP地址: http://127.0.0.1:${httpPort}`);
    Info(`WebSocket地址: ws://127.0.0.1:${wsPort}`);
}
