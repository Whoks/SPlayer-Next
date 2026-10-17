import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("恢复提示原位更新", () => {
  it("尝试次数更新保持同一消息，成功后按新时长自动关闭", async () => {
    const { toast, useToast } = await import("./useToast");
    const item = toast.loading("尝试 1/10", { duration: 0 });
    item.update("尝试 2/10", { type: "loading", duration: 0 });
    expect(useToast().toasts).toHaveLength(1);
    expect(useToast().toasts[0]).toMatchObject({
      id: item.id,
      message: "尝试 2/10",
      type: "loading",
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(useToast().toasts).toHaveLength(1);
    item.update("已恢复连接", { type: "success", duration: 3000 });
    await vi.advanceTimersByTimeAsync(2999);
    expect(useToast().toasts[0]?.type).toBe("success");
    await vi.advanceTimersByTimeAsync(1);
    expect(useToast().toasts).toHaveLength(0);
  });

  it("改为持续提示后取消原关闭定时器，关闭后更新不会复活消息", async () => {
    const { toast, useToast } = await import("./useToast");
    const item = toast.error("失败", { duration: 1000 });
    item.update("重连中", { type: "loading", duration: 0 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(useToast().toasts).toHaveLength(1);
    item.close();
    item.update("迟到结果", { type: "success" });
    expect(useToast().toasts).toHaveLength(0);
  });
});
