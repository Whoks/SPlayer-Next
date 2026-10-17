import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@shared/types/player";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  load: vi.fn(),
  play: vi.fn(),
  pause: vi.fn(),
  seek: vi.fn(),
  stop: vi.fn(),
  getStatus: vi.fn(),
  toast: vi.fn(),
  loading: vi.fn(),
  notification: { close: vi.fn(), update: vi.fn() },
  settings: {
    songLevel: "hq",
    allowTrialPlay: false,
    autoReconnect: true,
    reconnectAttempts: 3,
    reconnectFailureAction: "pause",
  },
}));

vi.mock("@/apis/netease", () => ({ netease: {}, neteaseCall: mocks.request }));
vi.mock("@/apis/song/qqmusic", () => ({ resolveQQMusicUrl: vi.fn() }));
vi.mock("@/apis/song/kugou", () => ({ resolveKugouUrl: vi.fn() }));
vi.mock("@/stores/user", () => ({
  useUserStore: () => ({ isLoggedIn: true, fetchStatus: async () => true }),
}));
vi.mock("@/stores/settings", () => ({
  useSettingsStore: () => ({
    preset: { skipKeywordsSongs: false, skipTrackKeywords: [] },
    player: mocks.settings,
    system: { cache: { songCache: { enabled: false } }, player: { rememberLastTrack: true } },
    lyric: { cjkTransform: "none" },
  }),
}));
vi.mock("@/stores/plugins", () => ({ usePluginsStore: () => ({ list: [] }) }));
vi.mock("@/stores/streaming", () => ({ useStreamingStore: vi.fn() }));
vi.mock("@/stores/history", () => ({ useHistoryStore: () => ({ record: vi.fn() }) }));
vi.mock("@/stores/library", () => ({ useLibraryStore: vi.fn() }));
vi.mock("localforage", () => ({
  default: { createInstance: () => ({ setItem: async () => null }) },
}));
vi.mock("./fm", () => ({}));
vi.mock("./stats", () => ({ installPlayStats: vi.fn(), onTrackEnded: vi.fn() }));
vi.mock("@/services/nextTrackPreloader", () => ({
  consumePreloadedTrack: () => null,
  invalidateNextTrackPreload: vi.fn(),
  scheduleNextTrackPreload: vi.fn(),
}));
vi.mock("@/services/lyric/loader", () => ({
  beginLoad: vi.fn(),
  loadForTrack: vi.fn(),
  watchLyricPreference: vi.fn(),
}));
vi.mock("@/services/coverLoader", () => ({ loadCoverForTrack: vi.fn() }));
vi.mock("@/services/abLoop", () => ({ reset: vi.fn(), checkLoop: vi.fn() }));
vi.mock("@/services/cacheScheduler", () => ({ cancel: vi.fn(), schedule: vi.fn(), tick: vi.fn() }));
vi.mock("@/services/deviceVolume", () => ({ getDeviceVolume: vi.fn(), setDeviceVolume: vi.fn() }));
vi.mock("@/composables/useFavorite", () => ({ useFavorite: vi.fn() }));
vi.mock("@/composables/useToast", () => ({
  toast: { error: mocks.toast, loading: mocks.loading, success: vi.fn() },
}));
vi.mock("@/composables/useDialog", () => ({ dialog: { alert: async () => undefined } }));
vi.mock("@/utils/color", () => ({ extractColorFromUrl: vi.fn() }));
vi.mock("@/i18n", () => ({
  default: { global: { t: (key: string) => key, te: () => true } },
}));

const tracks: Track[] = ["current", "next", "last"].map((id) => ({
  id,
  title: id,
  source: "netease",
  artists: [{ name: "测试歌手" }],
  duration: 180000,
}));
const oldUrl = "https://music.example/current?token=expired";
const newUrl = "https://music.example/current?token=fresh";
const resumePosition = 42000;

let player: typeof import("./index");
let events: typeof import("./events");
let playback: typeof import("@/services/playback");
let status: ReturnType<typeof import("@/stores/status").useStatusStore>;
let media: ReturnType<typeof import("@/stores/media").useMediaStore>;

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { createPinia, setActivePinia } = await import("pinia");
  setActivePinia(createPinia());
  const { reactive } = await import("vue");
  mocks.settings = reactive({
    songLevel: "hq",
    allowTrialPlay: false,
    autoReconnect: true,
    reconnectAttempts: 3,
    reconnectFailureAction: "pause",
  });
  Object.assign(window, {
    api: {
      player: {
        load: mocks.load,
        play: mocks.play,
        pause: mocks.pause,
        seek: mocks.seek,
        stop: mocks.stop,
        getStatus: mocks.getStatus,
      },
      download: { lookup: async () => null },
      nowPlaying: { update: vi.fn() },
    },
  });
  mocks.load.mockResolvedValue({
    success: true,
    data: { detail: {}, mediaInfo: { duration: 180000 } },
  });
  mocks.loading.mockReturnValue(mocks.notification);
  mocks.play.mockResolvedValue({ success: true });
  mocks.pause.mockResolvedValue({ success: true });
  mocks.seek.mockResolvedValue({ success: true });
  mocks.stop.mockResolvedValue({ success: true });
  mocks.getStatus.mockResolvedValue({
    success: true,
    data: { state: "paused", position: resumePosition, duration: 180000 },
  });
  mocks.request.mockResolvedValue({ data: [{ url: newUrl, freeTrialInfo: null }] });
  const queue = await import("@/stores/queue");
  queue.setQueue(tracks);
  status = (await import("@/stores/status")).useStatusStore();
  media = (await import("@/stores/media")).useMediaStore();
  media.setTrack(tracks[0]!);
  status.playIndex = 0;
  status.state = "paused";
  status.position = resumePosition;
  status.duration = 180000;
  status.currentSource = oldUrl;
  playback = await import("@/services/playback");
  playback.setDuration(180000);
  playback.setCurrentTime(resumePosition, { force: true });
  playback.setPlaying(false);
  player = await import("./index");
  events = await import("./events");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("在线歌曲暂停后地址失效恢复", () => {
  it("暂停数小时后恢复，重新获取官方地址并从原进度续播当前歌曲", async () => {
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(playback.getCurrentTime()).toBe(resumePosition);
    expect(mocks.request).not.toHaveBeenCalled();

    await player.play();
    let finish!: (result: unknown) => void;
    mocks.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const recovery = events.handleEvent({ type: "sourceError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(status.trackLoading).toBe(true);
    await events.handleEvent({
      type: "status",
      data: {
        state: "stopped",
        position: resumePosition,
        duration: 180000,
        volume: 1,
        speed: 1,
        isFinished: false,
      },
    });
    finish({ data: [{ url: newUrl, freeTrialInfo: null }] });
    await recovery;

    expect(mocks.request).toHaveBeenCalledExactlyOnceWith(
      "song_url",
      { id: "current", level: "exhigh" },
      { notifyAuthFailure: false },
    );
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
      newUrl,
      expect.objectContaining({ autoPlay: false }),
    );
    expect(mocks.seek).toHaveBeenCalledExactlyOnceWith(resumePosition);
    expect(mocks.load.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.seek.mock.invocationCallOrder[0]!,
    );
    expect(mocks.seek.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.play.mock.invocationCallOrder[1]!,
    );
    expect(mocks.play).toHaveBeenCalledTimes(2);
    expect(media.track?.id).toBe("current");
    expect(status.playIndex).toBe(0);
    expect(status.currentSource).toBe(newUrl);
    expect(status.state).toBe("playing");
    expect(status.position).toBe(resumePosition);
    expect(playback.getCurrentTime()).toBe(resumePosition);
    expect(status.trackLoading).toBe(false);
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("保持暂停时收到源失效，刷新地址和进度但不自动播放", async () => {
    await events.handleEvent({ type: "sourceError" });
    expect(status.state).toBe("paused");
    expect(status.position).toBe(resumePosition);
    expect(media.track?.id).toBe("current");
    expect(mocks.seek).toHaveBeenCalledExactlyOnceWith(resumePosition);
    expect(mocks.play).not.toHaveBeenCalled();
  });

  it.each([false, true])("重新取址仍无音源时只跳一首，恢复播放=%s", async (resume) => {
    if (resume) await player.play();
    mocks.request.mockResolvedValueOnce({ data: [{ url: null, fee: 0 }] });
    await events.handleEvent({ type: "sourceError" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(media.track?.id).toBe("next");
    expect(status.state).toBe(resume ? "playing" : "paused");
    expect(mocks.request.mock.calls.map((call) => call[1].id)).toEqual(["current", "next"]);
    expect(mocks.seek).not.toHaveBeenCalled();
  });

  it.each(["停止", "切歌"])("取址期间手动%s，旧地址返回后不复活旧歌曲", async (action) => {
    await player.play();
    let finish!: (result: unknown) => void;
    mocks.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const recovery = events.handleEvent({ type: "sourceError" });
    await vi.advanceTimersByTimeAsync(0);
    if (action === "停止") await player.stop();
    else await player.nextTrack();
    mocks.load.mockClear();
    mocks.play.mockClear();
    finish({ data: [{ url: newUrl, freeTrialInfo: null }] });
    await recovery;
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.seek).not.toHaveBeenCalled();
    expect(mocks.play).not.toHaveBeenCalled();
    expect(status.state).toBe(action === "停止" ? "stopped" : "playing");
    expect(media.track?.id).toBe(action === "停止" ? "current" : "next");
  });

  it("恢复进度期间手动停止，迟到的 seek 响应不能重新播放", async () => {
    await player.play();
    let finish!: (result: unknown) => void;
    mocks.seek.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const recovery = events.handleEvent({ type: "sourceError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.seek).toHaveBeenCalledOnce();
    await player.stop();
    mocks.load.mockClear();
    mocks.play.mockClear();
    finish({ success: true });
    await recovery;
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.play).not.toHaveBeenCalled();
    expect(status.state).toBe("stopped");
  });

  it.each([false, true])("重新取址期间用户暂停，音源可用=%s 时仍保持暂停", async (available) => {
    await player.play();
    let finish!: (result: unknown) => void;
    mocks.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const recovery = events.handleEvent({ type: "sourceError" });
    await vi.advanceTimersByTimeAsync(0);
    await player.pause();
    mocks.play.mockClear();
    finish({ data: [{ url: available ? newUrl : null, freeTrialInfo: null }] });
    await recovery;
    expect(mocks.play).not.toHaveBeenCalled();
    expect(status.state).toBe("paused");
    expect(status.position).toBe(available ? resumePosition : 0);
    expect(media.track?.id).toBe(available ? "current" : "next");
  });
});

describe("网络中断的有限恢复", () => {
  const disconnected = () => mocks.request.mockRejectedValue(new Error("network disconnected"));

  it("网络失败保留当前歌曲及进度，每次失败后等待1500ms，耗尽后暂停", async () => {
    await player.play();
    disconnected();
    const recovery = events.handleEvent({ type: "sourceError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(media.track?.id).toBe("current");
    expect(status.position).toBe(42000);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1499);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1500);
    await recovery;
    expect(mocks.request).toHaveBeenCalledTimes(3);
    expect(media.track?.id).toBe("current");
    expect(status.position).toBe(42000);
    expect(status.state).toBe("paused");
    expect(status.trackLoading).toBe(false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(mocks.request).toHaveBeenCalledTimes(3);
  });

  it("网络恢复后仍从原进度续播，失败尝试不能消耗播放进度", async () => {
    await player.play();
    mocks.request.mockRejectedValueOnce(new Error("offline"));
    const recovery = events.handleEvent({ type: "sourceError" });
    await vi.advanceTimersByTimeAsync(1500);
    await recovery;
    expect(media.track?.id).toBe("current");
    expect(status.state).toBe("playing");
    expect(status.position).toBe(42000);
    expect(mocks.seek).toHaveBeenCalledExactlyOnceWith(42000);
  });

  it("等待期间暂停，恢复成功后保持暂停", async () => {
    await player.play();
    mocks.request.mockRejectedValueOnce(new Error("offline"));
    const recovery = events.handleEvent({ type: "sourceError" });
    await vi.advanceTimersByTimeAsync(0);
    await player.pause();
    await vi.advanceTimersByTimeAsync(1500);
    await recovery;
    expect(media.track?.id).toBe("current");
    expect(status.state).toBe("paused");
    expect(status.position).toBe(42000);
    expect(mocks.play).toHaveBeenCalledTimes(1);
  });

  it.each(["停止", "切歌"])("等待期间%s，取消旧歌曲的后续尝试", async (action) => {
    await player.play();
    mocks.request.mockRejectedValueOnce(new Error("offline"));
    const recovery = events.handleEvent({ type: "sourceError" });
    await vi.advanceTimersByTimeAsync(0);
    if (action === "停止") await player.stop();
    else await player.nextTrack();
    await vi.advanceTimersByTimeAsync(10000);
    await recovery;
    expect(mocks.request.mock.calls.map((call) => call[1].id)).toEqual(
      action === "停止" ? ["current"] : ["current", "next"],
    );
    expect(status.state).toBe(action === "停止" ? "stopped" : "playing");
  });

  it("关闭自动重连时不请求音源，直接保留当前进度暂停", async () => {
    mocks.settings.autoReconnect = false;
    await player.play();
    await events.handleEvent({ type: "sourceError" });
    expect(mocks.request).not.toHaveBeenCalled();
    expect(media.track?.id).toBe("current");
    expect(status.state).toBe("paused");
    expect(status.position).toBe(42000);
  });

  it("运行中关闭重连，即使策略为跳曲也取消并停留当前歌曲", async () => {
    mocks.settings.reconnectFailureAction = "next";
    await player.play();
    disconnected();
    const recovery = events.handleEvent({ type: "sourceError" });
    await vi.advanceTimersByTimeAsync(0);
    mocks.settings.autoReconnect = false;
    await vi.advanceTimersByTimeAsync(10000);
    await recovery;
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(media.track?.id).toBe("current");
    expect(status.state).toBe("paused");
    expect(status.trackLoading).toBe(false);
  });

  it("本轮采用次数和策略快照，耗尽跳曲后不获得新重试预算", async () => {
    mocks.settings.reconnectAttempts = 2;
    mocks.settings.reconnectFailureAction = "next";
    await player.play();
    disconnected();
    const recovery = events.handleEvent({ type: "sourceError" });
    await vi.advanceTimersByTimeAsync(0);
    mocks.settings.reconnectAttempts = 10;
    mocks.settings.reconnectFailureAction = "pause";
    await vi.advanceTimersByTimeAsync(1500);
    await recovery;
    expect(mocks.request.mock.calls.map((call) => call[1].id)).toEqual([
      "current",
      "current",
      "next",
    ]);
    expect(media.track?.id).toBe("next");
    expect(status.trackLoading).toBe(false);
    await vi.advanceTimersByTimeAsync(20000);
    expect(mocks.request).toHaveBeenCalledTimes(3);
  });

  it("耗尽后用户主动播放，可以重新取址并恢复原进度", async () => {
    mocks.settings.reconnectAttempts = 1;
    await player.play();
    disconnected();
    await events.handleEvent({ type: "sourceError" });
    mocks.request.mockResolvedValue({ data: [{ url: newUrl, freeTrialInfo: null }] });
    await player.play();
    expect(media.track?.id).toBe("current");
    expect(status.state).toBe("playing");
    expect(status.position).toBe(42000);
    expect(mocks.seek).toHaveBeenCalledWith(42000);
  });
});

describe("恢复请求的边界", () => {
  it("取址未完成时不并发重试，失败返回后才开始1500ms等待", async () => {
    await player.play();
    let reject!: (error: Error) => void;
    mocks.request.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const recovery = events.handleEvent({ type: "sourceError" });
    await vi.advanceTimersByTimeAsync(10000);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    reject(new Error("network timeout"));
    await vi.advanceTimersByTimeAsync(1499);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await recovery;
    expect(status.state).toBe("playing");
    expect(status.position).toBe(42000);
  });

  it("暂停后即使重试耗尽且选择跳曲，也保持当前歌曲", async () => {
    mocks.settings.reconnectFailureAction = "next";
    await player.play();
    mocks.request.mockRejectedValue(new Error("offline"));
    const recovery = events.handleEvent({ type: "sourceError" });
    await vi.advanceTimersByTimeAsync(0);
    await player.pause();
    await vi.advanceTimersByTimeAsync(3000);
    await recovery;
    expect(media.track?.id).toBe("current");
    expect(status.state).toBe("paused");
    expect(status.position).toBe(42000);
  });

  it("恢复进度失败不能宣布成功或从头自动播放", async () => {
    mocks.settings.reconnectAttempts = 1;
    await player.play();
    mocks.seek.mockResolvedValueOnce({ success: false, error: "NETWORK_ERROR" });
    await events.handleEvent({ type: "sourceError" });
    expect(status.state).toBe("paused");
    expect(status.position).toBe(42000);
    expect(mocks.play).toHaveBeenCalledTimes(1);
    expect(status.trackLoading).toBe(false);
  });

  it("重复源失效事件共享一轮预算", async () => {
    await player.play();
    mocks.request.mockRejectedValueOnce(new Error("offline"));
    const recovery = events.handleEvent({ type: "sourceError" });
    await vi.advanceTimersByTimeAsync(0);
    await events.handleEvent({ type: "sourceError" });
    expect(mocks.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500);
    await recovery;
    expect(status.state).toBe("playing");
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });

  it("取址期间关闭开关，迟到的成功结果不能启动原生加载", async () => {
    await player.play();
    let finish!: (value: unknown) => void;
    mocks.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const recovery = events.handleEvent({ type: "sourceError" });
    await vi.advanceTimersByTimeAsync(0);
    mocks.settings.autoReconnect = false;
    finish({ data: [{ url: newUrl, freeTrialInfo: null }] });
    await recovery;
    expect(mocks.load).not.toHaveBeenCalled();
    expect(status.state).toBe("paused");
    expect(status.position).toBe(42000);
    expect(status.trackLoading).toBe(false);
  });
});

it("重建音源尚未完成时也保持原进度显示", async () => {
  await player.play();
  let finish!: (result: unknown) => void;
  mocks.load.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const recovery = events.handleEvent({ type: "sourceError" });
  await vi.advanceTimersByTimeAsync(0);
  expect(status.position).toBe(42000);
  expect(playback.getCurrentTime()).toBe(42000);
  finish({ success: true, data: { detail: {}, mediaInfo: { duration: 180000 } } });
  await recovery;
  expect(status.position).toBe(42000);
});

it("等待期间手动热重载后，后续播放不重复发起旧恢复", async () => {
  await player.play();
  mocks.request.mockRejectedValueOnce(new Error("offline"));
  const recovery = events.handleEvent({ type: "sourceError" });
  await vi.advanceTimersByTimeAsync(0);
  await player.reloadCurrentTrack();
  await recovery;
  await player.pause();
  mocks.request.mockClear();
  await player.play();
  expect(mocks.request).not.toHaveBeenCalled();
  expect(status.state).toBe("playing");
  expect(status.position).toBe(42000);
});

it("关闭自动重连后仍允许用户手动重新播放", async () => {
  mocks.settings.autoReconnect = false;
  await player.play();
  await events.handleEvent({ type: "sourceError" });
  await player.play();
  expect(mocks.request).toHaveBeenCalledOnce();
  expect(status.state).toBe("playing");
  expect(status.position).toBe(42000);
});

it("耗尽后引擎停止和位置事件不能抹掉保留进度", async () => {
  mocks.settings.reconnectAttempts = 1;
  await player.play();
  mocks.request.mockRejectedValue(new Error("offline"));
  await events.handleEvent({ type: "sourceError" });
  await events.handleEvent({
    type: "status",
    data: {
      state: "stopped",
      position: 0,
      duration: 0,
      volume: 1,
      speed: 1,
      isFinished: false,
    },
  });
  await events.handleEvent({ type: "position", data: { position: 0, duration: 0 } });
  expect(status.state).toBe("paused");
  expect(status.position).toBe(42000);
  expect(status.duration).toBe(180000);
  expect(playback.getCurrentTime()).toBe(42000);
  mocks.request.mockResolvedValue({ data: [{ url: newUrl, freeTrialInfo: null }] });
  await player.play();
  expect(status.state).toBe("playing");
  expect(mocks.seek).toHaveBeenLastCalledWith(42000);
});

it("关闭重连后引擎的停止通知不清空进度", async () => {
  mocks.request.mockRejectedValue(new Error("offline"));
  const recovery = events.handleEvent({ type: "sourceError" });
  await vi.advanceTimersByTimeAsync(0);
  mocks.settings.autoReconnect = false;
  await recovery;
  await events.handleEvent({
    type: "status",
    data: {
      state: "stopped",
      position: 0,
      duration: 0,
      volume: 1,
      speed: 1,
      isFinished: false,
    },
  });
  expect(status.state).toBe("paused");
  expect(status.position).toBe(42000);
});

it("同一坏帧反复触发源失效时不无限重载", async () => {
  await player.play();
  await events.handleEvent({ type: "sourceError" });
  await events.handleEvent({ type: "sourceError" });
  expect(mocks.request.mock.calls.map((call) => call[1].id)).toEqual(["current", "next"]);
  expect(media.track?.id).toBe("next");
});

it("网络状态仍显示在线时首次尝试也显示加载提示", async () => {
  let finish!: (value: unknown) => void;
  mocks.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const recovery = events.handleEvent({ type: "sourceError" });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.loading).toHaveBeenCalledWith("player.reconnectTrying", { duration: 0 });
  finish({ data: [{ url: newUrl, freeTrialInfo: null }] });
  await recovery;
});

it("原生跳转声称成功但实际仍在开头时，不能自动播放旧曲", async () => {
  await player.play();
  mocks.getStatus.mockResolvedValueOnce({ success: true, data: { state: "paused", position: 0 } });
  await events.handleEvent({ type: "sourceError" });
  expect(mocks.play).toHaveBeenCalledTimes(1);
  expect(media.track?.id).toBe("next");
  expect(mocks.toast).toHaveBeenCalledWith("errors.FILE_DECODE_ERROR");
});

it("恢复后正常播放再向前拖动，新的断网仍进入重连", async () => {
  await player.play();
  await events.handleEvent({ type: "sourceError" });
  await events.handleEvent({ type: "position", data: { position: 60000, duration: 180000 } });
  await player.seek(10000);
  mocks.getStatus.mockResolvedValue({ success: true, data: { state: "paused", position: 10000 } });
  await events.handleEvent({ type: "sourceError" });
  expect(media.track?.id).toBe("current");
  expect(mocks.request.mock.calls.map((call) => call[1].id)).toEqual(["current", "current"]);
  expect(status.position).toBe(10000);
});

it("恢复后暂停数小时再手动播放，过期地址可以重新恢复", async () => {
  await player.play();
  await events.handleEvent({ type: "sourceError" });
  await player.pause();
  await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
  await player.play();
  await events.handleEvent({ type: "sourceError" });
  expect(media.track?.id).toBe("current");
  expect(mocks.request).toHaveBeenCalledTimes(2);
});

it("原生重建期间播放键仍可切换为暂停意图", async () => {
  await player.play();
  let finish!: (result: unknown) => void;
  mocks.load.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const recovery = events.handleEvent({ type: "sourceError" });
  await vi.advanceTimersByTimeAsync(0);
  expect(status.isPlaying).toBe(true);
  expect(status.isLoading).toBe(false);
  player.togglePlay();
  await vi.advanceTimersByTimeAsync(0);
  finish({ success: true, data: { detail: {}, mediaInfo: { duration: 180000 } } });
  await recovery;
  expect(status.state).toBe("paused");
  expect(mocks.play).toHaveBeenCalledTimes(1);
  expect(status.position).toBe(42000);
});

it("等待恢复进度时播放键仍可取消自动续播", async () => {
  await player.play();
  let finish!: (result: unknown) => void;
  mocks.seek.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const recovery = events.handleEvent({ type: "sourceError" });
  await vi.advanceTimersByTimeAsync(0);
  expect(status.isPlaying).toBe(true);
  player.togglePlay();
  await vi.advanceTimersByTimeAsync(0);
  finish({ success: true });
  await recovery;
  expect(status.state).toBe("paused");
  expect(mocks.play).toHaveBeenCalledTimes(1);
});

it("重试间隙保留加载提示，只在耗尽时显示一次原有音源错误", async () => {
  await player.play();
  mocks.request.mockRejectedValue(new Error("offline"));
  const recovery = events.handleEvent({ type: "sourceError" });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.toast).not.toHaveBeenCalled();
  expect(
    mocks.notification.update.mock.calls.filter((call) => call[1]?.type === "error"),
  ).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1500);
  expect(
    mocks.notification.update.mock.calls.filter((call) => call[1]?.type === "error"),
  ).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1500);
  await recovery;
  expect(mocks.notification.update.mock.calls.filter((call) => call[1]?.type === "error")).toEqual([
    ["errors.NETWORK_ERROR", { type: "error", duration: 3000 }],
  ]);
  expect(mocks.loading).toHaveBeenCalledTimes(1);
});

it("关闭重连时直接显示音源连接失败，不显示重连提示", async () => {
  mocks.settings.autoReconnect = false;
  await events.handleEvent({ type: "sourceError" });
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.loading).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledExactlyOnceWith("errors.NETWORK_ERROR", { duration: 3000 });
});

it("耗尽后可归零当前歌曲播放进度，保留列表但不自动跳曲", async () => {
  mocks.settings.reconnectAttempts = 1;
  mocks.settings.reconnectFailureAction = "stop";
  await player.play();
  mocks.request.mockRejectedValue(new Error("offline"));
  await events.handleEvent({ type: "sourceError" });
  expect(status.state).toBe("stopped");
  expect(status.position).toBe(0);
  expect(status.playIndex).toBe(0);
  expect(media.track?.id).toBe("current");
  const queue = await import("@/stores/queue");
  expect(queue.queueLength.value).toBe(3);
  await vi.advanceTimersByTimeAsync(10000);
  expect(mocks.request).toHaveBeenCalledTimes(1);
});

it("选择归零当前歌曲播放进度后，恢复期间主动暂停仍保留原进度", async () => {
  mocks.settings.reconnectAttempts = 2;
  mocks.settings.reconnectFailureAction = "stop";
  await player.play();
  mocks.request.mockRejectedValue(new Error("offline"));
  const recovery = events.handleEvent({ type: "sourceError" });
  await vi.advanceTimersByTimeAsync(0);
  await player.pause();
  await vi.advanceTimersByTimeAsync(1500);
  await recovery;
  expect(status.state).toBe("paused");
  expect(status.position).toBe(42000);
  expect(media.track?.id).toBe("current");
});

it("归零当前歌曲播放进度等待原生停止时，迟到错误不能启动新恢复", async () => {
  mocks.settings.reconnectAttempts = 1;
  mocks.settings.reconnectFailureAction = "stop";
  await player.play();
  mocks.request.mockRejectedValue(new Error("offline"));
  let finish!: (value: unknown) => void;
  mocks.stop.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const recovery = events.handleEvent({ type: "sourceError" });
  await vi.advanceTimersByTimeAsync(0);
  const lateError = events.handleEvent({ type: "sourceError" });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.request).toHaveBeenCalledTimes(1);
  expect(mocks.load).not.toHaveBeenCalled();
  expect(mocks.play).toHaveBeenCalledTimes(1);
  finish({ success: true });
  await recovery;
  await lateError;
  expect(status.state).toBe("stopped");
  expect(status.position).toBe(0);
});

it("恢复网络后手动播放先静默加载，成功不闪现新一轮重连", async () => {
  mocks.settings.autoReconnect = false;
  await events.handleEvent({ type: "sourceError" });
  mocks.settings.autoReconnect = true;
  mocks.loading.mockClear();
  mocks.notification.update.mockClear();
  mocks.toast.mockClear();
  await player.play();
  expect(status.state).toBe("playing");
  expect(status.position).toBe(42000);
  expect(mocks.request).toHaveBeenCalledTimes(1);
  expect(mocks.loading).not.toHaveBeenCalled();
  expect(mocks.notification.update).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
});

it("静默加载失败后才从1开始显示完整重连预算", async () => {
  mocks.settings.autoReconnect = false;
  await events.handleEvent({ type: "sourceError" });
  mocks.settings.autoReconnect = true;
  mocks.settings.reconnectAttempts = 2;
  mocks.loading.mockClear();
  mocks.notification.update.mockClear();
  mocks.toast.mockClear();
  mocks.request.mockRejectedValue(new Error("offline"));
  const recovery = player.play();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.request).toHaveBeenCalledTimes(1);
  expect(mocks.loading).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1500);
  expect(mocks.request).toHaveBeenCalledTimes(2);
  expect(mocks.loading).toHaveBeenCalledTimes(1);
  expect(
    mocks.notification.update.mock.calls.filter((call) => call[1]?.type === "error"),
  ).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1500);
  await recovery;
  expect(mocks.request).toHaveBeenCalledTimes(3);
  expect(
    mocks.notification.update.mock.calls.filter((call) => call[1]?.type === "error"),
  ).toHaveLength(1);
  expect(status.state).toBe("paused");
  expect(status.position).toBe(42000);
});

it("静默加载期间暂停，成功仍保持暂停且不出现恢复通知", async () => {
  mocks.settings.autoReconnect = false;
  await events.handleEvent({ type: "sourceError" });
  mocks.settings.autoReconnect = true;
  mocks.loading.mockClear();
  mocks.notification.update.mockClear();
  let finish!: (value: unknown) => void;
  mocks.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const recovery = player.play();
  await vi.advanceTimersByTimeAsync(0);
  await player.pause();
  finish({ data: [{ url: newUrl, freeTrialInfo: null }] });
  await recovery;
  expect(status.state).toBe("paused");
  expect(mocks.play).not.toHaveBeenCalled();
  expect(mocks.loading).not.toHaveBeenCalled();
  expect(mocks.notification.update).not.toHaveBeenCalled();
});
