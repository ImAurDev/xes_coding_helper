export function portIsAvailable(port: number): boolean {
    try {
        const listener = Deno.listen({ port, transport: "tcp" });
        listener.close();
        return true;
    } catch (e) {
        if (e instanceof Deno.errors.AddrInUse) return false;
        throw e;
    }
}

export async function getFirstAvailable(
    candidates: number[],
): Promise<number> {
    for (const p of candidates) {
        if (await portIsAvailable(p)) return p;
    }
    throw new Error("所有的端口都被占用了");
}

export function getPort(): Promise<number> {
    return getFirstAvailable([55820, 55825, 55830, 55835]);
}
