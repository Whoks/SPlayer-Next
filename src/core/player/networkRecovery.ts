import { toast, type ToastInstance } from "@/composables/useToast";
import i18n from "@/i18n";

/** 单次恢复只持有一个取消信号、一条提示和一个等待定时器 */
export class NetworkRecovery {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private finishWait: (() => void) | null = null;
  private notification: ToastInstance | null = null;
  pausedByUser = false;

  /**
   * 保存本轮重连的曲目、固定进度和播放意图
   * @param trackId - 恢复目标曲目 ID
   * @param position - 缓冲耗尽时的进度（毫秒）
   * @param wantsPlay - 恢复成功后是否继续播放
   * @param maxAttempts - 自动重连的最大次数
   * @param failureAction - 重连耗尽后的播放策略
   */
  constructor(
    readonly trackId: string,
    readonly position: number,
    public wantsPlay: boolean,
    readonly maxAttempts: number,
    readonly failureAction: "pause" | "next" | "stop",
  ) {}

  /**
   * 更新尝试次数，失败间隙保留原提示，避免反复切换为错误状态
   * @param attempt - 正在进行的尝试次数
   */
  notify(attempt: number): void {
    const message = i18n.global.t("player.reconnectTrying", { attempt, total: this.maxAttempts });
    if (this.notification) this.notification.update(message, { type: "loading", duration: 0 });
    else this.notification = toast.loading(message, { duration: 0 });
  }

  /** 每次失败后等待，取消时立即解除等待 */
  wait(): Promise<void> {
    return new Promise((resolve) => {
      this.finishWait = () => {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        this.finishWait = null;
        resolve();
      };
      this.timer = setTimeout(() => this.finishWait?.(), 1500);
      if (this.signal.aborted) this.finishWait();
    });
  }

  /** 中止等待和在途结果，释放提示 */
  cancel(): void {
    this.controller.abort();
    this.finishWait?.();
    this.notification?.close();
    this.notification = null;
  }

  /**
   * 结束本轮，将最终提示交给有界 toast 队列自动关闭
   * @param type - 最终提示类型，省略时关闭原提示
   */

  finish(type?: "error" | "success"): void {
    if (type) {
      const message = i18n.global.t(
        type === "success" ? "player.reconnectSuccess" : "errors.NETWORK_ERROR",
      );
      if (this.notification) this.notification.update(message, { type, duration: 3000 });
      else toast[type](message, { duration: 3000 });
    } else {
      this.notification?.close();
    }
    this.notification = null;
  }
}
