export function Info(msg: string) {
    console.info(`\n[INFO] ${msg}`);
}

export function Warn(msg: string) {
    console.warn(`\n[WARN] ${msg}`);
}

export function Error(msg: string) {
    console.error(`\n[ERROR] ${msg}`);
}

export function Debug(msg: string) {
    console.log(`\n[DEBUG] ${msg}`);
}
