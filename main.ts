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

async function runPythonCode(
    code: string,
): Promise<{ output: string; error: boolean }> {
    try {
        if (!code || code.trim() === "") {
            return { output: "代码不能为空！", error: true };
        }

        const tempDir = await Deno.makeTempDir();
        const tempFile = `${tempDir}/temp_code.py`;

        await Deno.writeTextFile(tempFile, code);

        const command = new Deno.Command("python3", {
            args: [tempFile],
            stdout: "piped",
            stderr: "piped",
        });

        const { code: exitCode, stdout, stderr } = await command.output();
        const rawOutput = new TextDecoder().decode(stdout);
        const rawError = new TextDecoder().decode(stderr);

        await Deno.remove(tempFile);
        await Deno.remove(tempDir);

        if (exitCode !== 0) {
            const lines = rawError.split("\n");
            let mainError = "";
            for (const line of lines) {
                if (
                    line.trim().startsWith("File") ||
                    line.includes("SyntaxError") ||
                    line.includes("NameError") ||
                    line.includes("TypeError") ||
                    line.includes("ValueError") ||
                    line.includes("IndentationError") ||
                    line.includes("AttributeError")
                ) {
                    mainError = line.trim();
                    break;
                }
            }

            if (!mainError) {
                mainError = rawError.trim().split("\n").slice(-2).join(" ") ||
                    rawError.trim();
            }

            const errorInfo = code + "\a\n" + mainError;
            return { output: errorInfo, error: true };
        }

        return { output: rawOutput.trim(), error: false };
    } catch (error) {
        const errorInfo = code + "\a\n" + error.message;
        return { output: errorInfo, error: true };
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

            socket.onopen = () => Debug("Websocket 客户端连接");

            socket.onmessage = async (e) => {
                try {
                    Info(`接收到信息: ${e.data}`);

                    const dataStr = e.data.toString();
                    if (dataStr.startsWith("7")) {
                        try {
                            const jsonStr = dataStr.substring(1);
                            const data = JSON.parse(jsonStr);

                            let pythonCode = "";

                            if (data.xml && data.xml.trim() !== "") {
                                pythonCode = data.xml;
                            } else if (
                                data.tabsListData &&
                                data.tabsListData.length > 0
                            ) {
                                const mainFile = data.tabsListData.find((
                                    tab: any,
                                ) => tab.name === "main.py" ||
                                    tab.ext === "py"
                                );
                                if (
                                    mainFile && mainFile.value &&
                                    mainFile.value.trim() !== ""
                                ) {
                                    pythonCode = mainFile.value;
                                } else if (
                                    mainFile && mainFile.content &&
                                    mainFile.content.trim() !== ""
                                ) {
                                    pythonCode = mainFile.content;
                                }
                            }

                            if (!pythonCode || pythonCode.trim() === "") {
                                socket.send(
                                    "7eyJUeXBlIjogInJ1bkluZm8iLCAiSW5mbyI6ICLku6PnoIHkuI3og73kuLrnqbrvvIEifQ==",
                                );
                                return;
                            }

                            const result = await runPythonCode(pythonCode);

                            const outputBase64 = toBase64(result.output);
                            const message1 = "1" + outputBase64;
                            socket.send(message1);
                            socket.send(
                                "7eyJUeXBlIjogInJ1bkluZm8iLCAiSW5mbyI6ICJcclxuXHJcblx1NGVlM1x1NzgwMVx1OGZkMFx1ODg0Y1x1N2VkM1x1Njc1ZiJ9",
                            );
                        } catch (parseError) {
                            console.error("解析消息时出错:", parseError);
                            const errorMsg = `解析错误: ${parseError.message}`;
                            const errorBase64 = toBase64(errorMsg);
                            socket.send("1" + errorBase64);
                        }
                    } else {
                        socket.send(e.data);
                    }
                } catch (error) {
                    console.error("处理消息时出错:", error);
                    const errorMsg = `处理错误: ${error.message}`;
                    const errorBase64 = toBase64(errorMsg);
                    socket.send("1" + errorBase64);
                }
            };

            socket.onclose = () => Debug("Websocket 客户端断开");
            socket.onerror = (error) => {
                console.error("WebSocket错误:", error);
            };

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
