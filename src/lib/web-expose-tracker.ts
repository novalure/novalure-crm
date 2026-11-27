import type { WebExposeEvent, WebExposeEventType, WebExposeSection } from "@/lib/web-expose";

/** One visible section receives each interval. Background and idle intervals earn no time. */
export class ExposeActiveClock {
  private previous: number;
  private lastActivity: number;
  constructor(now: number) { this.previous = now; this.lastActivity = now; }
  activity(now: number) { this.lastActivity = now; }
  sample(now: number, visible: boolean, focused: boolean) {
    const elapsed = Math.max(0, Math.min(1500, now - this.previous));
    this.previous = now;
    return visible && focused && now - this.lastActivity <= 30000 ? Math.floor(elapsed) : 0;
  }
}
export function startExposeTracker(input: { token: string; sessionToken: string; onWithdrawReady?: (withdraw: () => void) => void }) {
  const endpoint = `/api/public/exposes/${encodeURIComponent(input.token)}`;
  let stopped = false, sending = false, sequence = 0, qualified = 0, opened = false, inquiryStarted = false;
  let current: WebExposeSection = "hero", activeMs = 0;
  const reached = new Set<WebExposeSection>();
  const queue: WebExposeEvent[] = [];
  const clock = new ExposeActiveClock(performance.now());
  function event(type: WebExposeEventType, section = current, extra: Partial<WebExposeEvent> = {}) {
    if (stopped || queue.length >= 200) return;
    queue.push({ id: crypto.randomUUID(), sequence: ++sequence, type, section, ...extra });
  }
  async function send() {
    if (stopped || sending || !queue.length) return;
    sending = true;
    const batch = queue.splice(0, 30);
    try {
      const response = await fetch(endpoint, { method: "POST", credentials: "omit", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "events", sessionToken: input.sessionToken, events: batch }) });
      if (!response.ok && !stopped) queue.unshift(...batch);
    } catch { if (!stopped) queue.unshift(...batch); }
    finally { sending = false; }
  }
  function flushTime() {
    if (activeMs > 0) event("heartbeat", current, { activeMs: Math.min(10000, activeMs) });
    activeMs = 0;
  }
  function sample() {
    const credited = clock.sample(performance.now(), document.visibilityState === "visible", document.hasFocus());
    if (!credited) { flushTime(); return; }
    qualified += credited;
    if (!opened && qualified >= 1000) { opened = true; event("open", "hero"); }
    const sections = [...document.querySelectorAll<HTMLElement>("[data-expose-section]")].map(el => {
      const r = el.getBoundingClientRect();
      return { el, rect: r, visible: Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(0, r.top)) };
    }).sort((a, b) => b.visible - a.visible);
    const selected = sections[0];
    if (selected && selected.visible >= Math.min(160, selected.rect.height * 0.4)) {
      const next = selected.el.dataset.exposeSection as WebExposeSection;
      if (next !== current) { flushTime(); current = next; }
      const depth = Math.round(Math.min(100, Math.max(0, (innerHeight - selected.rect.top) / selected.rect.height * 100)));
      if (!reached.has(next)) { reached.add(next); event("section", next, { depth }); }
    }
    activeMs += credited;
    if (activeMs >= 5000) { flushTime(); void send(); }
  }
  const activity = () => clock.activity(performance.now());
  const hide = () => { sample(); flushTime(); void send(); };
  const click = (e: MouseEvent) => {
    const el = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-expose-event]") : null;
    if (!el) return;
    const type = el.dataset.exposeEvent as WebExposeEventType;
    const section = el.closest<HTMLElement>("[data-expose-section]")?.dataset.exposeSection as WebExposeSection || current;
    event(type, section, { target: el.dataset.exposeTarget || "button" }); void send();
  };
  const mediaAction=(e:Event)=>{
    if(!(e.target instanceof HTMLVideoElement)||!e.target.dataset.exposeTarget)return;
    const action=e.type==="play"?"play":e.type==="pause"?"pause":"ended";
    event("video","videos",{target:e.target.dataset.exposeTarget+":"+action});void send();
  };
  const inquiryStart = (e: FocusEvent) => {
    if (e.target instanceof Element && e.target.closest("[data-expose-inquiry]") && !inquiryStarted) {
      inquiryStarted = true; event("inquiry_start", "contact"); void send();
    }
  };
  ["pointerdown", "keydown", "scroll", "touchstart"].forEach(type => window.addEventListener(type, activity, { passive: true }));
  window.addEventListener("focus", activity); window.addEventListener("pagehide", hide);
  document.addEventListener("visibilitychange", hide); document.addEventListener("click", click); document.addEventListener("focusin", inquiryStart);
  ["play","pause","ended"].forEach(type=>document.addEventListener(type,mediaAction,true));
  const interval = setInterval(() => { sample(); void send(); }, 1000);
  function stop(withdraw: boolean) {
    stopped = true; queue.length = 0; clearInterval(interval);
    ["pointerdown", "keydown", "scroll", "touchstart"].forEach(type => window.removeEventListener(type, activity));
    window.removeEventListener("focus", activity); window.removeEventListener("pagehide", hide);
    document.removeEventListener("visibilitychange", hide); document.removeEventListener("click", click); document.removeEventListener("focusin", inquiryStart);
    ["play","pause","ended"].forEach(type=>document.removeEventListener(type,mediaAction,true));
    if (withdraw) void fetch(endpoint, { method: "POST", credentials: "omit", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "withdraw", sessionToken: input.sessionToken }) });
  }
  input.onWithdrawReady?.(() => stop(true));
  return () => stop(false);
}
