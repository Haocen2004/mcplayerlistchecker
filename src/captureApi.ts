import { startNeoForgeConfigServer } from './neoforgeConfigServer';

export interface CaptureControllerOptions {
    targetHost: string;
    targetPort: number;
    minecraftVersion: string;
    cacheFile?: string;
    defaultPort: number;
    defaultTimeoutMs: number;
    forceOverwrite?: boolean;
}

export interface CaptureResult {
    at: string;
    declarations: number;
    cacheKey: string;
    cacheFile: string;
    address: string;
    protocolVersion: string;
}

/**
 * 「仅采集」接口的控制器。
 *
 * 采集模式本身只是一个**监听用的最小 NeoForge 服务端**（不登录游戏、不占用任何账号），
 * 让真实客户端连上来一次，把它的 modded network 频道声明抓下来写入 probe 缓存。
 * 模组包更新后（频道版本/必需性变化）用它刷新声明即可，不必重启主程序。
 *
 * 通过 HTTP 暴露（见 api.ts）：
 *   POST /capture/start   开启采集服务端（body 可选：{ port, timeoutMs, reconnect }）
 *   GET  /capture/status  查看状态与最近一次采集结果
 *   POST /capture/stop    停止采集服务端
 */
export class CaptureController {
    private options: CaptureControllerOptions | null = null;
    private server: any = null;
    private listeningPort = 0;
    private listenHost = '';
    private startedAt: string | null = null;
    private lastCapture: CaptureResult | null = null;
    private lastError: string | null = null;
    private reconnectHandler: (() => void) | null = null;
    private reconnectAfterCapture = true;

    configure(options: CaptureControllerOptions) {
        this.options = options;
    }

    /** 采集成功后是否让主连接重连（以便立即使用新声明），由 index.ts 注册 */
    setReconnectHandler(handler: () => void) {
        this.reconnectHandler = handler;
    }

    isListening(): boolean {
        return this.server !== null;
    }

    status() {
        return {
            enabled: this.options !== null,
            listening: this.isListening(),
            port: this.isListening() ? this.listeningPort : null,
            listenHost: this.isListening() ? this.listenHost : null,
            startedAt: this.startedAt,
            target: this.options ? `${this.options.targetHost}:${this.options.targetPort}` : null,
            minecraftVersion: this.options?.minecraftVersion ?? null,
            lastCapture: this.lastCapture,
            lastError: this.lastError
        };
    }

    start(body: any = {}) {
        if (!this.options) {
            throw new Error('capture 接口未启用：请在 config.json 中设置 "captureApiEnabled": true');
        }

        const port = Number(body.port ?? this.options.defaultPort);
        const timeoutMs = Number(body.timeoutMs ?? this.options.defaultTimeoutMs);
        if (!Number.isFinite(port) || port <= 0) throw new Error('port 必须是正整数');
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs 必须是正整数');

        if (this.isListening()) {
            return { ok: true, alreadyRunning: true, ...this.status() };
        }

        this.reconnectAfterCapture = body.reconnect !== false;
        this.lastError = null;

        // mc.createServer 的类型声明未包含通用 EventEmitter 事件，这里按 any 使用
        const server: any = startNeoForgeConfigServer({
            listenHost: String(body.host ?? '0.0.0.0'),
            listenPort: port,
            targetHost: this.options.targetHost,
            targetPort: this.options.targetPort,
            minecraftVersion: this.options.minecraftVersion,
            cacheFile: this.options.cacheFile,
            captureTimeoutMs: timeoutMs,
            forceOverwrite: this.options.forceOverwrite,
            onCaptureCompleted: (result) => this.handleCaptureCompleted(result)
        });

        server.on('error', (err: Error) => {
            this.lastError = err.message;
            console.error(`[Capture API] 采集服务端错误：${err.message}`);
        });
        server.on('close', () => {
            if (this.server !== server) return;
            this.server = null;
            this.listeningPort = 0;
            this.listenHost = '';
            this.startedAt = null;
        });

        this.server = server;
        this.listeningPort = port;
        this.listenHost = String(body.host ?? '0.0.0.0');
        this.startedAt = new Date().toISOString();

        console.log(`[Capture API] 采集服务端已启动：${this.listenHost}:${port}（目标缓存 key 源 ${this.options.targetHost}:${this.options.targetPort}），`
            + '请用真实客户端连接该端口，采集完成后会自动写入缓存。');

        return {
            ok: true,
            listening: true,
            port,
            timeoutMs,
            target: `${this.options.targetHost}:${this.options.targetPort}`,
            reconnectAfterCapture: this.reconnectAfterCapture,
            hint: '用真实客户端连接 <本机IP>:' + port + '，然后 GET /capture/status 查看结果'
        };
    }

    stop() {
        if (!this.server) return { ok: true, wasListening: false };
        const server = this.server;
        this.server = null;
        this.listeningPort = 0;
        this.listenHost = '';
        this.startedAt = null;
        try {
            server.close();
        } catch (e) {
            this.lastError = (e as Error).message;
        }
        console.log('[Capture API] 采集服务端已停止');
        return { ok: true, wasListening: true };
    }

    private handleCaptureCompleted(result: Omit<CaptureResult, 'at'>) {
        this.lastCapture = { at: new Date().toISOString(), ...result };
        console.log(`[Capture API] 采集完成：${result.declarations} 条声明（缓存 ${result.cacheKey}）`);

        if (!this.reconnectAfterCapture) return;
        try {
            this.reconnectHandler?.();
        } catch (e) {
            console.error(`[Capture API] 采集后触发重连失败：${(e as Error).message}`);
        }
    }
}

export const captureController = new CaptureController();
