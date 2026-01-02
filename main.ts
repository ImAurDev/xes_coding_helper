import { Debug, Info } from "./lib/info.ts";
import { getPort } from "./lib/ports.ts";

const version = "2.13.0";

const router = new Map<
    string,
    (req: Request) => Promise<Response> | Response
>();

const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data, null, 2), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "access-control-allow-origin": "*",
        },
    });

router.set("GET@/ping", () => json({ data: { auto: true } }));
router.set("GET@/version", () => json({ data: { version } }));

router.set("POST@/path", async (req) => {
    try {
        const body = await req.json();
        if (!body.id) return json({ message: "缺少 id" }, 400);

        const port = await getPort();
        return json({
            path: `http://127.0.0.1:${port + 4}/${body.id}`,
        });
    } catch (e) {
        return json({ message: (e as Error).message }, 400);
    }
});

function toBase64(str: string): string {
    const bytes = new TextEncoder().encode(str);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

interface PythonProcess {
    command: Deno.ChildProcess;
    stdin: WritableStreamDefaultWriter<Uint8Array>;
    stdoutReader: ReadableStreamDefaultReader<Uint8Array>;
    stderrReader: ReadableStreamDefaultReader<Uint8Array>;
    cleanup: () => Promise<void>;
    socket: WebSocket;
    processId: string;
    isFinished: boolean;
    inputBuffer: string;
}

const activeProcesses = new Map<string, PythonProcess>();

function generateProcessId(): string {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

async function runPythonCode(
    code: string,
    processId: string,
    socket: WebSocket
): Promise<void> {
    try {
        if (!code || code.trim() === "") {
            const errorMsg = "代码不能为空！";
            const errorBase64 = toBase64(errorMsg);
            socket.send("1" + errorBase64);
            return;
        }

        const tempDir = await Deno.makeTempDir();
        const tempFile = `${tempDir}/temp_code.py`;
        
        await Deno.writeTextFile(tempFile, code);

        const command = new Deno.Command("python3", {
            args: ["-u", tempFile],
            stdin: "piped",
            stdout: "piped",
            stderr: "piped",
        });

        const childProcess = command.spawn();
        
        const stdinWriter = childProcess.stdin.getWriter();
        const stdoutReader = childProcess.stdout.getReader();
        const stderrReader = childProcess.stderr.getReader();
        
        const cleanup = async () => {
            try {
                stdinWriter.releaseLock();
                stdoutReader.releaseLock();
                stderrReader.releaseLock();
                
                try {
                    childProcess.kill("SIGTERM");
                } catch (_e) {}
                
                try {
                    await Deno.remove(tempFile);
                    await Deno.remove(tempDir);
                } catch (_e) {}
                
                const process = activeProcesses.get(processId);
                if (process) {
                    process.isFinished = true;
                }
                activeProcesses.delete(processId);
            } catch (e) {}
        };
        
        const processInfo: PythonProcess = {
            command: childProcess,
            stdin: stdinWriter,
            stdoutReader,
            stderrReader,
            cleanup,
            socket,
            processId,
            isFinished: false,
            inputBuffer: ""
        };
        
        activeProcesses.set(processId, processInfo);
        
        const readOutput = async () => {
            try {
                while (true) {
                    const { done, value } = await stdoutReader.read();
                    if (done) break;
                    
                    const output = new TextDecoder().decode(value);
                    if (output) {
                        const outputBase64 = toBase64(output);
                        socket.send("1" + outputBase64);
                    }
                }
            } catch (e) {}
        };
        
        const readError = async () => {
            try {
                while (true) {
                    const { done, value } = await stderrReader.read();
                    if (done) break;
                    
                    const error = new TextDecoder().decode(value);
                    if (error) {
                        const errorBase64 = toBase64(error);
                        socket.send("1" + errorBase64);
                    }
                }
            } catch (e) {}
        };
        
        childProcess.status.then(async (status) => {
            await cleanup();
            socket.send("7eyJUeXBlIjogInJ1bkluZm8iLCAiSW5mbyI6ICJcclxuXHJcblx1NGVlM1x1NzgwMVx1OGZkMFx1ODg0Y1x1N2VkM1x1Njc1ZiJ9");
            socket.send("7eyJUeXBlIjogInNpZ25hbCIsICJJbmZvIjogIntcIm5ld1wiOiBbXSwgXCJkZWxcIjogW10sIFwibW9kXCI6IFtdLCBcImRpcl9kZWxcIjogW10sIFwiZGlyX25ld1wiOiBbXSwgXCJ0eXBlXCI6IFwiY2hhbmdlZFwifSJ9");
        }).catch(async (error) => {
            await cleanup();
            socket.send("7eyJUeXBlIjogInJ1bkluZm8iLCAiSW5mbyI6ICJcclxuXHJcblx1NGVlM1x1NzgwMVx1OGZkMFx1ODg0Y1x1N2VkM1x1Njc1ZiJ9");
            socket.send("7eyJUeXBlIjogInNpZ25hbCIsICJJbmZvIjogIntcIm5ld1wiOiBbXSwgXCJkZWxcIjogW10sIFwibW9kXCI6IFtdLCBcImRpcl9kZWxcIjogW10sIFwiZGlyX25ld1wiOiBbXSwgXCJ0eXBlXCI6IFwiY2hhbmdlZFwifSJ9");
        });
        
        readOutput();
        readError();
        
    } catch (error) {
        const errorMsg = `启动错误: ${error.message}`;
        const errorBase64 = toBase64(errorMsg);
        socket.send("1" + errorBase64);
        socket.send("7eyJUeXBlIjogInJ1bkluZm8iLCAiSW5mbyI6ICJcclxuXHJcblx1NGVlM1x1NzgwMVx1OGZkMFx1ODg0Y1x1N2VkM1x1Njc1ZiJ9");
        socket.send("7eyJUeXBlIjogInNpZ25hbCIsICJJbmZvIjogIntcIm5ld1wiOiBbXSwgXCJkZWxcIjogW10sIFwibW9kXCI6IFtdLCBcImRpcl9kZWxcIjogW10sIFwiZGlyX25ld1wiOiBbXSwgXCJ0eXBlXCI6IFwiY2hhbmdlZFwifSJ9");
    }
}

function createHttpHandler() {
    return (req: Request): Response | Promise<Response> => {
        const url = new URL(req.url);
        const key = `${req.method}@${url.pathname}`;
        const fn = router.get(key);
        if (fn) return fn(req);

        return new Response(
            "HTTP端点:\n- GET /ping\n- GET /version\n- POST /path\n",
            {
                status: 200,
                headers: { "content-type": "text/plain; charset=utf-8" },
            },
        );
    };
}

function createWebSocketHandler() {
    return (req: Request): Response => {
        if (req.headers.get("upgrade") === "websocket") {
            const { socket, response } = Deno.upgradeWebSocket(req);

            let currentProcessId: string | null = null;

            socket.onopen = () => {
                Debug("Websocket 客户端连接");
            };

            socket.onmessage = async (e) => {
                try {
                    const dataStr = e.data.toString();
                    
                    if (dataStr.startsWith("1")) {
                        const inputData = dataStr.substring(1);
                        
                        if (currentProcessId) {
                            const process = activeProcesses.get(currentProcessId);
                            if (process && !process.isFinished) {
                                process.inputBuffer += inputData;
                            }
                        }
                        return;
                    }
                    
                    if (dataStr.startsWith("7")) {
                        try {
                            const jsonStr = dataStr.substring(1);
                            const data = JSON.parse(jsonStr);
                            
                            if (data.type === "conn" && data.handle === "close") {
                                if (currentProcessId) {
                                    const process = activeProcesses.get(currentProcessId);
                                    if (process) {
                                        await process.cleanup();
                                        socket.send("7eyJUeXBlIjogInJ1bkluZm8iLCAiSW5mbyI6ICJcclxuXHJcblx1NGVlM1x1NzgwMVx1OGZkMFx1ODg0Y1x1N2VkM1x1Njc1ZiJ9");
                                        socket.send("7eyJUeXBlIjogInNpZ25hbCIsICJJbmZvIjogIntcIm5ld1wiOiBbXSwgXCJkZWxcIjogW10sIFwibW9kXCI6IFtdLCBcImRpcl9kZWxcIjogW10sIFwiZGlyX25ld1wiOiBbXSwgXCJ0eXBlXCI6IFwiY2hhbmdlZFwifSJ9");
                                    }
                                }
                                return;
                            }

                            let pythonCode = "";

                            if (data.xml && data.xml.trim() !== "") {
                                pythonCode = String(data.xml);
                            } else if (data.tabsListData && data.tabsListData.length > 0) {
                                const mainFile = data.tabsListData.find((
                                    tab: any,
                                ) => tab.name === "main.py" || tab.ext === "py");
                                if (mainFile && mainFile.value && mainFile.value.trim() !== "") {
                                    pythonCode = String(mainFile.value);
                                } else if (mainFile && mainFile.content && mainFile.content.trim() !== "") {
                                    pythonCode = String(mainFile.content);
                                }
                            }
                            
                            pythonCode = pythonCode.trim().replace(/\\n/g, '\n');
                            
                            if (!pythonCode || pythonCode.trim() === "") {
                                return;
                            }

                            if (currentProcessId) {
                                const oldProcess = activeProcesses.get(currentProcessId);
                                if (oldProcess) {
                                    try {
                                        await oldProcess.cleanup();
                                    } catch (e) {}
                                }
                            }

                            currentProcessId = generateProcessId();
                            
                            socket.send("7eyJUeXBlIjogInJ1bkluZm8iLCAiSW5mbyI6ICJcclxuXHJcblx1NGVlM1x1NzgwMVx1OGZkMFx1ODg0Y1x1N2VkM1x1Njc1ZiJ9");

                            runPythonCode(pythonCode, currentProcessId, socket);

                        } catch (parseError) {
                            socket.send("7eyJUeXBlIjogInJ1bkluZm8iLCAiSW5mbyI6ICJcclxuXHJcblx1NGVlM1x1NzgwMVx1OGZkMFx1ODg0Y1x1N2VkM1x1Njc1ZiJ9");
                            socket.send("7eyJUeXBlIjogInNpZ25hbCIsICJJbmZvIjogIntcIm5ld1wiOiBbXSwgXCJkZWxcIjogW10sIFwibW9kXCI6IFtdLCBcImRpcl9kZWxcIjogW10sIFwiZGlyX25ld1wiOiBbXSwgXCJ0eXBlXCI6IFwiY2hhbmdlZFwifSJ9");
                        }
                    }
                } catch (error) {
                    socket.send("7eyJUeXBlIjogInJ1bkluZm8iLCAiSW5mbyI6ICJcclxuXHJcblx1NGVlM1x1NzgwMVx1OGZkMFx1ODg0Y1x1N2VkM1x1Njc1ZiJ9");
                    socket.send("7eyJUeXBlIjogInNpZ25hbCIsICJJbmZvIjogIntcIm5ld1wiOiBbXSwgXCJkZWxcIjogW10sIFwibW9kXCI6IFtdLCBcImRpcl9kZWxcIjogW10sIFwiZGlyX25ld1wiOiBbXSwgXCJ0eXBlXCI6IFwiY2hhbmdlZFwifSJ9");
                }
            };

            socket.onclose = async () => {
                Debug("Websocket 客户端断开");
                if (currentProcessId) {
                    const process = activeProcesses.get(currentProcessId);
                    if (process) {
                        try {
                            await process.cleanup();
                        } catch (e) {}
                    }
                }
            };
            
            socket.onerror = (error) => {};

            return response;
        }

        return new Response("只支持WebSocket连接", { status: 400 });
    };
}

if (import.meta.main) {
    const basePort = await getPort();

    const httpPort = basePort;
    const wsPort = basePort + 1;

    Debug(`HTTP服务将于端口 ${httpPort} 监听`);
    Deno.serve({ port: httpPort }, createHttpHandler());

    Debug(`WebSocket服务将于端口 ${wsPort} 监听`);
    Deno.serve({ port: wsPort }, createWebSocketHandler());

    Info(`HTTP地址: http://127.0.0.1:${httpPort}`);
    Info(`WebSocket地址: ws://127.0.0.1:${wsPort}`);
}