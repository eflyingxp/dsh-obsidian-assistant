// dsh-obsidian-assistant — Client half（手写 __ModuleLoader__ bundle，无需构建步骤）。
//
// v0.2.1 界面改版：
//   - 右上角新增「展开到整页 / 收起为浮窗」按钮（关闭按钮左侧）。
//   - 整页模式使用 shell.overlay 里的全屏浮层：遮罩 + 居中大页面，点遮罩或按 Esc 回到浮窗。
//   - 全部样式改为基于 DSH 主题 token 的 CSS 类（--dsw-alias-*），跟随浅色/深色主题。
//   - 卡片化列表、分段标签、加载/空态/错误态统一，浮窗与整页共享同一套组件。
window.__ModuleLoader__.load({
  id: "dsh-obsidian-assistant",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");
    const c = React.createElement;
    const Fragment = React.Fragment;

    // Host 侧 obsbn 服务经 Typert Gateway 的 SRC 通道暴露，但没有编译期
    // Remote 贡献，客户端不会出现 remote.obsbn 服务——改走 connection 的
    // 通用 /api RPC（POST /api/obsbn/<method>），网关按 SRC 声明认领分发。
    const inject = ["connection", "slots"];

    // 参数名即 wire 字段：Host 方法签名 walk(args)/read(args) 等，
    // 所以 payload.args = { args: <业务参数> }；today()/health() 无参传 {}。
    function makeRemote(connection) {
      const call = (method, wireArgs) =>
        connection.rpc.call("/api", "obsbn/" + method, { args: wireArgs }).then((res) => {
          if (!res || res.ok !== true) {
            throw new Error((res && res.error && res.error.message) || "调用失败");
          }
          return res.value;
        });
      return {
        today: () => call("today", {}),
        walk: (a) => call("walk", { args: a }),
        quicknote: (a) => call("quicknote", { args: a }),
        recent: () => call("recent", {}),
        related: (a) => call("related", { args: a }),
        read: (a) => call("read", { args: a }),
        health: () => call("health", {}),
      };
    }

    // 预计算/后台刷新时的轮询上限，Host 可用 retryInMs 覆盖间隔。
    const MAX_POLLS = 30;
    function pollDelay(r) {
      const n = Number(r && r.retryInMs);
      return n > 0 ? n : 1200;
    }

    function formatToday() {
      const d = new Date();
      const wd = "日一二三四五六"[d.getDay()];
      return d.getMonth() + 1 + " 月 " + d.getDate() + " 日 · 周" + wd;
    }

    // -----------------------------------------------------------------------
    // 样式：只用 DSH 主题 token，浅色/深色自动跟随；类名统一 obsbn- 前缀。
    // -----------------------------------------------------------------------
    const CSS = `
.obsbn-root{position:fixed;inset:0;pointer-events:none;z-index:30;color:var(--dsw-alias-label-primary,inherit);font-family:inherit}
.obsbn-launcher{position:fixed;right:24px;bottom:24px;width:50px;height:50px;border-radius:16px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#7c6cf0) 40%,transparent);background:var(--dsw-alias-brand-primary,#7c6cf0);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 12px 28px color-mix(in srgb,var(--dsw-alias-brand-primary,#7c6cf0) 38%,transparent),0 2px 6px rgba(0,0,0,.14);transition:transform .16s ease,box-shadow .16s ease;z-index:40}
.obsbn-launcher:hover{transform:translateY(-2px) scale(1.03);box-shadow:0 16px 34px color-mix(in srgb,var(--dsw-alias-brand-primary,#7c6cf0) 46%,transparent),0 3px 8px rgba(0,0,0,.18)}
.obsbn-launcher:active{transform:scale(.97)}
.obsbn-floating{position:absolute;inset:0;pointer-events:none}
.obsbn-floating>*{pointer-events:auto}
.obsbn-panel{position:absolute;right:24px;bottom:24px;width:min(444px,calc(100vw - 32px));max-height:min(780px,calc(100vh - 48px));display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#fff));border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));border-radius:20px;box-shadow:0 28px 70px rgba(0,0,0,.30),0 3px 10px rgba(0,0,0,.10);animation:obsbn-pop .17s ease-out}
@keyframes obsbn-pop{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}
.obsbn-backdrop{position:fixed;inset:0;pointer-events:auto;z-index:50;display:flex;align-items:center;justify-content:center;padding:26px;background:rgba(12,14,20,.40);backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);animation:obsbn-fade .16s ease-out}
@keyframes obsbn-fade{from{opacity:0}to{opacity:1}}
.obsbn-page{width:min(1040px,100%);height:min(820px,100%);display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));border-radius:22px;box-shadow:0 36px 90px rgba(0,0,0,.36);animation:obsbn-rise .19s ease-out}
@keyframes obsbn-rise{from{opacity:0;transform:translateY(12px) scale(.992)}to{opacity:1;transform:none}}
.obsbn-head{display:flex;align-items:center;gap:11px;padding:15px 16px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16))}
.obsbn-logo{width:36px;height:36px;border-radius:11px;display:flex;align-items:center;justify-content:center;flex:none;color:var(--dsw-alias-brand-primary,#7c6cf0);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#7c6cf0) 13%,transparent)}
.obsbn-brand{min-width:0;flex:1}
.obsbn-name{font-size:14px;font-weight:650;letter-spacing:.01em;line-height:1.25}
.obsbn-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary,#7a7a85);margin-top:3px;line-height:1.2}
.obsbn-actions{display:flex;align-items:center;gap:3px;flex:none}
.obsbn-iconbtn{width:31px;height:31px;border-radius:10px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#777);display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;transition:background .14s ease,color .14s ease,border-color .14s ease}
.obsbn-iconbtn:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,inherit)}
.obsbn-iconbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#7c6cf0);outline-offset:1px}
.obsbn-health{display:flex;gap:8px;align-items:flex-start;padding:8px 16px;font-size:12px;line-height:1.45;cursor:pointer;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16))}
.obsbn-health--error{color:var(--dsw-alias-state-error-primary,#c0392b);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 9%,transparent)}
.obsbn-health--warn{color:var(--dsw-alias-state-warn-primary,#a15c00);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#a15c00) 10%,transparent)}
.obsbn-health-line{display:flex;gap:7px;align-items:baseline;flex:1;min-width:0}
.obsbn-health-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:560}
.obsbn-health-hint{flex:none;opacity:.78;font-size:11px;color:inherit}
.obsbn-health-detail{margin-top:7px;padding-top:7px;border-top:1px solid color-mix(in srgb,currentColor 24%,transparent)}
.obsbn-health-item+.obsbn-health-item{margin-top:8px}
.obsbn-health-item b{font-weight:620}
.obsbn-health-item p{margin:2px 0 0;opacity:.92}
.obsbn-tabs{display:flex;gap:4px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.06))}
.obsbn-tab{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:7px 10px;border:none;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary,#777);font-size:12.5px;font-weight:550;font-family:inherit;cursor:pointer;transition:background .14s ease,color .14s ease,box-shadow .14s ease}
.obsbn-tab:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.10));color:var(--dsw-alias-label-primary,inherit)}
.obsbn-tab.is-active{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,inherit);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));box-shadow:0 1px 3px rgba(0,0,0,.10)}
.obsbn-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#7c6cf0);outline-offset:1px}
.obsbn-body{flex:1;min-height:0;overflow:auto;padding:14px 16px 20px;scrollbar-width:thin;overscroll-behavior:contain}
.obsbn-body--wide{padding:22px 26px 28px}
.obsbn-body::-webkit-scrollbar{width:9px;height:9px}
.obsbn-body::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-secondary,#777) 26%,transparent);border-radius:999px;border:2px solid transparent;background-clip:content-box}
.obsbn-body::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--dsw-alias-label-secondary,#777) 42%,transparent);background-clip:content-box}
.obsbn-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px;align-items:start}
.obsbn-sectionhead{display:flex;align-items:center;gap:10px;margin:2px 0 12px;min-height:20px}
.obsbn-chip{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;font-size:11.5px;font-weight:560;color:var(--dsw-alias-brand-primary,#7c6cf0);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#7c6cf0) 11%,transparent)}
.obsbn-muted{font-size:11.5px;color:var(--dsw-alias-label-secondary,#7a7a85);line-height:1.5}
.obsbn-grow{flex:1;min-width:0}
.obsbn-card{background:var(--dsw-alias-bg-base,transparent);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));border-radius:13px;padding:13px 15px;margin-bottom:10px;transition:border-color .15s ease,background .15s ease}
.obsbn-grid .obsbn-card{margin-bottom:0}
.obsbn-card:hover{border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.34))}
.obsbn-entry-top{display:flex;align-items:baseline;gap:8px;min-width:0}
.obsbn-year{flex:none;font-size:12px;font-weight:660;font-variant-numeric:tabular-nums;color:var(--dsw-alias-brand-primary,#7c6cf0);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#7c6cf0) 12%,transparent);border-radius:7px;padding:2px 7px;line-height:1.5}
.obsbn-entry-title{flex:1;min-width:0;margin:0;font-size:12.5px;font-weight:560;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#777)}
.obsbn-summary{margin:8px 0 0;font-size:13px;line-height:1.7;color:var(--dsw-alias-label-primary,inherit)}
.obsbn-foot{display:flex;justify-content:flex-end;margin-top:8px}
.obsbn-link{border:none;background:transparent;color:var(--dsw-alias-brand-primary,#7c6cf0);font-size:11.5px;font-weight:560;font-family:inherit;cursor:pointer;padding:3px 7px;border-radius:7px;transition:background .14s ease}
.obsbn-link:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#7c6cf0) 10%,transparent)}
.obsbn-notepanel{margin-top:10px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));border-radius:11px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.05))}
.obsbn-notepanel-head{display:flex;align-items:center;gap:8px;padding:8px 11px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 65%,transparent)}
.obsbn-notepath{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-secondary,#777);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.obsbn-note-pre{margin:0;padding:11px 13px;max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:1.7;font-family:inherit;color:var(--dsw-alias-label-primary,inherit)}
.obsbn-body--wide .obsbn-note-pre{max-height:52vh}
.obsbn-body--wide .obsbn-letter{max-width:860px;margin:0 auto}
.obsbn-body--wide .obsbn-letter-text{max-width:78ch}
.obsbn-body--wide .obsbn-actionsrow{max-width:860px;margin-left:auto;margin-right:auto}
.obsbn-letter{border-left:3px solid var(--dsw-alias-brand-primary,#7c6cf0);padding:16px 18px;background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-brand-primary,#7c6cf0) 6%,transparent),transparent 62%),var(--dsw-alias-bg-base,transparent)}
.obsbn-letter-text{white-space:pre-wrap;font-size:13.5px;line-height:1.9}
.obsbn-letter-meta{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 10px;margin-top:14px;padding-top:10px;border-top:1px dashed var(--dsw-alias-border-l1,rgba(128,128,128,.24));font-size:11.5px;color:var(--dsw-alias-label-secondary,#7a7a85)}
.obsbn-letter-src{font-weight:560;color:var(--dsw-alias-label-primary,inherit)}
.obsbn-letter-path{font-size:10.5px;opacity:.72;word-break:break-all}
.obsbn-actionsrow{display:flex;gap:9px;margin:14px 0 4px}
.obsbn-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:7px 14px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.34));background:transparent;color:var(--dsw-alias-label-primary,inherit);font-size:12.5px;font-weight:560;font-family:inherit;cursor:pointer;transition:background .14s ease,border-color .14s ease,transform .12s ease,filter .14s ease}
.obsbn-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.10))}
.obsbn-btn:active{transform:scale(.985)}
.obsbn-btn:disabled{opacity:.55;cursor:default;transform:none}
.obsbn-btn--primary{background:var(--dsw-alias-brand-primary,#7c6cf0);border-color:transparent;color:#fff}
.obsbn-btn--primary:hover{filter:brightness(1.06);background:var(--dsw-alias-brand-primary,#7c6cf0)}
.obsbn-btn--ghost{border-color:var(--dsw-alias-border-l1,rgba(128,128,128,.20));color:var(--dsw-alias-label-secondary,#777)}
.obsbn-btn--ghost:hover{color:var(--dsw-alias-label-primary,inherit)}
.obsbn-btn--small{padding:5px 11px;font-size:11.5px;border-radius:8px}
.obsbn-textarea{width:100%;box-sizing:border-box;min-height:92px;padding:11px 13px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.30));background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,inherit);font-family:inherit;font-size:13px;line-height:1.65;resize:vertical;outline:none;transition:border-color .15s ease,box-shadow .15s ease}
.obsbn-textarea::placeholder{color:var(--dsw-alias-label-secondary,#9a9aa5);opacity:.85}
.obsbn-textarea:focus{border-color:var(--dsw-alias-brand-primary,#7c6cf0);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#7c6cf0) 16%,transparent)}
.obsbn-body--wide .obsbn-textarea{min-height:150px}
.obsbn-status{display:flex;align-items:center;gap:6px;margin:9px 0 3px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#777)}
.obsbn-status--ok{color:var(--dsw-alias-state-success-primary,#1a7f37)}
.obsbn-status--error{color:var(--dsw-alias-state-error-primary,#c0392b)}
.obsbn-loading{display:flex;align-items:center;gap:9px;padding:22px 4px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#7a7a85)}
.obsbn-spinner{width:14px;height:14px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:obsbn-spin .8s linear infinite;opacity:.62;flex:none}
@keyframes obsbn-spin{to{transform:rotate(360deg)}}
.obsbn-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:6px;padding:38px 18px;color:var(--dsw-alias-label-secondary,#7a7a85)}
.obsbn-empty-glyph{width:44px;height:44px;border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:20px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.10));margin-bottom:4px}
.obsbn-empty-title{font-size:13px;font-weight:560;color:var(--dsw-alias-label-primary,inherit)}
.obsbn-empty-detail{font-size:12px;line-height:1.6;max-width:340px}
.obsbn-errorbox{border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 32%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 7%,transparent);border-radius:12px;padding:13px 15px;margin:4px 0 12px}
.obsbn-error-title{font-size:12.5px;font-weight:620;color:var(--dsw-alias-state-error-primary,#c0392b);margin-bottom:4px}
.obsbn-error-text{font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-primary,inherit);word-break:break-word}
.obsbn-errorbox .obsbn-btn{margin-top:9px}
.obsbn-recent{margin-top:20px;padding-top:15px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18))}
.obsbn-recent-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:9px}
.obsbn-recent-title{font-size:11.5px;font-weight:620;letter-spacing:.04em;color:var(--dsw-alias-label-secondary,#7a7a85)}
.obsbn-recent-item{padding:11px 13px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.15));margin-bottom:7px;cursor:pointer;transition:background .14s ease,border-color .14s ease}
.obsbn-recent-item:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.06));border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.3))}
.obsbn-recent-top{display:flex;align-items:baseline;gap:8px}
.obsbn-recent-text{flex:1;min-width:0;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.obsbn-recent-time{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary,#8a8a95);font-variant-numeric:tabular-nums}
.obsbn-recent-body{margin-top:9px}
.obsbn-recent-full{font-size:12.5px;line-height:1.7;white-space:pre-wrap;padding:9px 11px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08));margin-bottom:11px;word-break:break-word}
.obsbn-related-head{font-size:11.5px;color:var(--dsw-alias-label-secondary,#7a7a85);margin-bottom:7px}
.obsbn-score{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary,#8a8a95);font-variant-numeric:tabular-nums}
.obsbn-code{font-size:10.5px;opacity:.75;word-break:break-all;margin-top:3px}
@media (max-width:640px){
  .obsbn-backdrop{padding:10px}
  .obsbn-page{height:calc(100vh - 20px);border-radius:15px}
  .obsbn-panel{right:12px;bottom:12px;max-height:calc(100vh - 24px);border-radius:16px}
  .obsbn-head{padding:13px 13px 10px}
  .obsbn-body{padding:12px 13px 16px}
  .obsbn-body--wide{padding:15px 14px 20px}
}
@media (prefers-reduced-motion:reduce){
  .obsbn-launcher,.obsbn-panel,.obsbn-page,.obsbn-backdrop{animation:none;transition:none}
}
`;

    function StyleTag() {
      return c("style", { dangerouslySetInnerHTML: { __html: CSS } });
    }

    // -----------------------------------------------------------------------
    // 图标（内联 SVG，跟随 currentColor，不引入依赖）
    // -----------------------------------------------------------------------
    const svgProps = {
      viewBox: "0 0 16 16",
      width: 15,
      height: 15,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.6,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
    };

    function IconBook(props) {
      const size = (props && props.size) || 20;
      return c(
        "svg",
        Object.assign({}, svgProps, { width: size, height: size, viewBox: "0 0 20 20" }),
        c("path", { d: "M10 4.2C8.3 3 6.5 2.5 4.2 2.5v12.3c2.3 0 4.1.5 5.8 1.7 1.7-1.2 3.5-1.7 5.8-1.7V2.5c-2.3 0-4.1.5-5.8 1.7z" }),
        c("path", { d: "M10 4.2v12.3" })
      );
    }

    function IconExpand() {
      return c(
        "svg",
        svgProps,
        c("path", { d: "M6.5 2.5h-4v4" }),
        c("path", { d: "M9.5 2.5h4v4" }),
        c("path", { d: "M13.5 9.5v4h-4" }),
        c("path", { d: "M2.5 9.5v4h4" })
      );
    }

    function IconCollapse() {
      return c(
        "svg",
        svgProps,
        c("path", { d: "M6.5 6.5l-4-4" }),
        c("path", { d: "M2.5 6V2.5H6" }),
        c("path", { d: "M9.5 6.5l4-4" }),
        c("path", { d: "M13.5 6V2.5H10" }),
        c("path", { d: "M6.5 9.5l-4 4" }),
        c("path", { d: "M2.5 10v3.5H6" }),
        c("path", { d: "M9.5 9.5l4 4" }),
        c("path", { d: "M10 13.5h3.5V10" })
      );
    }

    function IconClose() {
      return c("svg", svgProps, c("path", { d: "M3.5 3.5l9 9" }), c("path", { d: "M12.5 3.5l-9 9" }));
    }

    // -----------------------------------------------------------------------
    // 通用小部件
    // -----------------------------------------------------------------------
    function Loading({ text }) {
      return c("div", { className: "obsbn-loading" }, c("span", { className: "obsbn-spinner", "aria-hidden": "true" }), c("span", null, text));
    }

    function ErrorBox({ text, onRetry }) {
      return c(
        "div",
        { className: "obsbn-errorbox", role: "alert" },
        c("div", { className: "obsbn-error-title" }, "出了点问题"),
        c("div", { className: "obsbn-error-text" }, text),
        onRetry ? c("button", { className: "obsbn-btn obsbn-btn--ghost obsbn-btn--small", onClick: onRetry }, "重试") : null
      );
    }

    function Empty({ glyph, title, detail, actionLabel, onAction }) {
      return c(
        "div",
        { className: "obsbn-empty" },
        glyph ? c("div", { className: "obsbn-empty-glyph", "aria-hidden": "true" }, glyph) : null,
        c("div", { className: "obsbn-empty-title" }, title),
        detail ? c("div", { className: "obsbn-empty-detail" }, detail) : null,
        actionLabel && onAction ? c("button", { className: "obsbn-btn obsbn-btn--ghost obsbn-btn--small", onClick: onAction }, actionLabel) : null
      );
    }

    function NoteView({ remote, path, onClose }) {
      const [state, setState] = React.useState({ loading: true, text: "", error: "" });
      React.useEffect(() => {
        let alive = true;
        remote.read({ path }).then(
          (r) => {
            if (!alive) return;
            if (r && r.error) setState({ loading: false, text: "", error: r.error });
            else setState({ loading: false, text: (r && r.text) || "（空）", error: "" });
          },
          (e) => alive && setState({ loading: false, text: "", error: String(e) })
        );
        return () => {
          alive = false;
        };
      }, [path]);
      return c(
        "div",
        { className: "obsbn-notepanel" },
        c(
          "div",
          { className: "obsbn-notepanel-head" },
          c("span", { className: "obsbn-notepath", title: path }, path),
          c("button", { className: "obsbn-btn obsbn-btn--ghost obsbn-btn--small", onClick: onClose }, "收起")
        ),
        state.loading
          ? c("div", { className: "obsbn-loading" }, c("span", { className: "obsbn-spinner" }), c("span", null, "读取原文…"))
          : state.error
            ? c("div", { className: "obsbn-error-text", style: { padding: "10px 13px" } }, state.error)
            : c("pre", { className: "obsbn-note-pre" }, state.text)
      );
    }

    // -----------------------------------------------------------------------
    // 健康条：只有 problems 才占位；ok 或只有 info 时返回 null
    // -----------------------------------------------------------------------
    function HealthBar({ remote }) {
      const [state, setState] = React.useState({ problems: [], open: false });
      React.useEffect(() => {
        if (typeof remote.health !== "function") return undefined;
        let alive = true;
        remote.health().then(
          (r) => {
            if (!alive) return;
            const problems = (r && r.problems) || [];
            if (problems.length > 0) setState({ problems, open: false });
          },
          () => {}
        );
        return () => {
          alive = false;
        };
      }, []);
      if (state.problems.length === 0) return null;
      const first = state.problems[0] || {};
      const kind = first.severity === "error" ? "error" : "warn";
      return c(
        "div",
        {
          className: "obsbn-health obsbn-health--" + kind,
          onClick: () => setState((s) => Object.assign({}, s, { open: !s.open })),
          title: state.open ? "收起详情" : "点击查看详情",
          role: "status",
        },
        c(
          "div",
          { className: "obsbn-health-line" },
          c("span", { "aria-hidden": "true" }, "⚠"),
          c("span", { className: "obsbn-health-title" }, first.title || "启动自检发现问题"),
          c("span", { className: "obsbn-health-hint" }, (state.problems.length > 1 ? "共 " + state.problems.length + " 项 · " : "") + (state.open ? "收起" : "详情"))
        ),
        state.open
          ? c(
              "div",
              { className: "obsbn-health-detail" },
              state.problems.map((p, i) =>
                c(
                  "div",
                  { key: p.id || i, className: "obsbn-health-item" },
                  c("b", null, p.title || "问题"),
                  p.detail ? c("p", null, p.detail) : null,
                  p.fix ? c("p", null, "修复：" + p.fix) : null
                )
              )
            )
          : null
      );
    }

    // -----------------------------------------------------------------------
    // 那年今天
    // -----------------------------------------------------------------------
    function TodayTab({ remote, wide, onGoQuick }) {
      const [state, setState] = React.useState({ loading: true, warming: false, data: null, error: "", openPath: null, updating: false });
      const [nonce, setNonce] = React.useState(0);

      React.useEffect(() => {
        let alive = true;
        let timer = null;
        let polls = 0;

        const fail = (e) => {
          if (!alive) return;
          setState({ loading: false, warming: false, data: null, error: String((e && e.message) || e), openPath: null, updating: false });
        };
        const poll = () => Promise.resolve(remote.today()).then(handle, fail);
        const handle = (r) => {
          if (!alive) return;
          if (r && r.error) {
            setState({ loading: false, warming: false, data: null, error: r.error, openPath: null, updating: false });
            return;
          }
          if (!r) {
            setState({ loading: false, warming: false, data: null, error: "没有收到返回数据，请重试。", openPath: null, updating: false });
            return;
          }
          if (r.warming === true) {
            if (polls >= MAX_POLLS) {
              setState((s) =>
                Object.assign({}, s, {
                  loading: !s.data,
                  warming: !s.data,
                  updating: false,
                  error: s.data ? "" : "首次预计算耗时较长，请稍后重试。",
                })
              );
              return;
            }
            polls += 1;
            setState((s) => Object.assign({}, s, { loading: !s.data, warming: !s.data, data: s.data, error: "", updating: !!s.data }));
            timer = setTimeout(() => {
              if (alive) poll();
            }, pollDelay(r));
            return;
          }
          const waiting = r.stale === true || r.refreshing === true;
          setState((s) => Object.assign({}, s, { loading: false, warming: false, data: r, error: "", updating: waiting }));
          if (waiting) {
            if (polls >= MAX_POLLS) {
              setState((s) => Object.assign({}, s, { updating: false }));
              return;
            }
            polls += 1;
            timer = setTimeout(() => {
              if (alive) poll();
            }, pollDelay(r));
          }
        };

        poll();
        return () => {
          alive = false;
          if (timer) clearTimeout(timer);
        };
      }, [nonce]);

      const retry = () => {
        setState({ loading: true, warming: false, data: null, error: "", openPath: null, updating: false });
        setNonce((n) => n + 1);
      };

      if (state.loading && !state.data) return c(Loading, { text: state.warming ? "首次预计算中…" : "正在翻找多年前的今天…" });
      if (state.error) return c(ErrorBox, { text: state.error, onRetry: retry });
      const entries = (state.data && state.data.entries) || [];
      if (entries.length === 0)
        return c(Empty, {
          glyph: "🗓",
          title: "这些年今天还没留下内容",
          detail: "今天写一条，明年今天它就会出现在这里。",
          actionLabel: "去写一条",
          onAction: onGoQuick,
        });
      const cards = entries.map((e) =>
        c(
          "article",
          { key: e.path, className: "obsbn-card" },
          c(
            "div",
            { className: "obsbn-entry-top" },
            c("span", { className: "obsbn-year" }, String(e.year)),
            c("span", { className: "obsbn-entry-title", title: e.title }, e.title)
          ),
          c("p", { className: "obsbn-summary" }, e.summary),
          state.openPath === e.path
            ? c(NoteView, {
                remote,
                path: e.path,
                onClose: () => setState((s) => Object.assign({}, s, { openPath: null })),
              })
            : c(
                "div",
                { className: "obsbn-foot" },
                c(
                  "button",
                  {
                    className: "obsbn-link",
                    onClick: () => setState((s) => Object.assign({}, s, { openPath: e.path })),
                  },
                  "看原文"
                )
              )
        )
      );
      return c(
        "div",
        null,
        c(
          "div",
          { className: "obsbn-sectionhead" },
          c("span", { className: "obsbn-chip" }, (state.data && state.data.month) + " 月 " + (state.data && state.data.day) + " 日"),
          c("span", { className: "obsbn-muted obsbn-grow" }, "共 " + entries.length + " 条"),
          state.updating ? c("span", { className: "obsbn-muted" }, "更新中…") : null
        ),
        c("div", { className: wide ? "obsbn-grid" : null }, cards)
      );
    }

    // -----------------------------------------------------------------------
    // 随机漫步
    // -----------------------------------------------------------------------
    function WalkTab({ remote }) {
      const [state, setState] = React.useState({ loading: true, data: null, error: "", updating: false });
      const [history, setHistory] = React.useState([]);
      const [req, setReq] = React.useState({ id: 0, exclude: [] });

      React.useEffect(() => {
        let alive = true;
        let timer = null;
        let polls = 0;

        const fail = (e) => {
          if (!alive) return;
          setState((s) => Object.assign({}, s, { loading: false, error: String((e && e.message) || e), updating: false }));
        };
        const poll = () => Promise.resolve(remote.walk({ exclude: req.exclude })).then(handle, fail);
        const handle = (r) => {
          if (!alive) return;
          if (r && r.error) {
            setState((s) => Object.assign({}, s, { loading: false, error: r.error, updating: false }));
            return;
          }
          if (!r) {
            setState((s) => Object.assign({}, s, { loading: false, error: "没有收到返回数据，请重试。", updating: false }));
            return;
          }
          if (r.warming === true) {
            if (polls >= MAX_POLLS) {
              setState((s) => Object.assign({}, s, { loading: false, error: "写信耗时较长，请稍后重试。", updating: false }));
              return;
            }
            polls += 1;
            setState((s) => Object.assign({}, s, { loading: true, error: "", updating: false }));
            timer = setTimeout(() => {
              if (alive) poll();
            }, pollDelay(r));
            return;
          }
          const letter = (r && r.letter) || "";
          if (!letter) {
            setState((s) => Object.assign({}, s, { loading: false, error: "这次没能写出来，稍后再试。", updating: false }));
            return;
          }
          const waiting = r.stale === true || r.refreshing === true;
          setState((s) => Object.assign({}, s, { loading: false, data: r, error: "", updating: waiting }));
          if (r.path) setHistory((h) => (h.indexOf(r.path) === -1 ? h.concat([r.path]).slice(-30) : h));
          if (waiting && polls < MAX_POLLS) {
            polls += 1;
            timer = setTimeout(() => {
              if (alive) poll();
            }, pollDelay(r));
          }
        };

        poll();
        return () => {
          alive = false;
          if (timer) clearTimeout(timer);
        };
      }, [req.id]);

      const reload = (exclude) => {
        setState((s) => Object.assign({}, s, { loading: true, error: "" }));
        setReq((r) => ({ id: r.id + 1, exclude }));
      };
      const retry = () => reload(req.exclude);
      const next = () => {
        const exclude = history.slice(-30);
        const cur = state.data && state.data.path;
        if (cur && exclude.indexOf(cur) === -1) exclude.push(cur);
        reload(exclude);
      };

      if (state.loading) return c(Loading, { text: state.data ? "正在更新…" : "过去正在写信…" });
      if (state.error) return c(ErrorBox, { text: state.error, onRetry: retry });
      const hasLetter = !!(state.data && state.data.letter);
      if (!hasLetter) return c(Empty, { glyph: "✉️", title: "还没有收到信", detail: "等你写完第一篇长笔记，它就会来找你。", actionLabel: "再来一次", onAction: retry });
      return c(
        "div",
        null,
        c(
          "article",
          { className: "obsbn-card obsbn-letter" },
          c("div", { className: "obsbn-letter-text" }, state.data.letter),
          c(
            "div",
            { className: "obsbn-letter-meta" },
            c("span", { className: "obsbn-letter-src" }, "来自《" + state.data.title + "》"),
            c("span", { className: "obsbn-letter-path" }, state.data.path),
            state.updating ? c("span", null, "正在更新…") : null
          )
        ),
        c("div", { className: "obsbn-actionsrow" }, c("button", { className: "obsbn-btn obsbn-btn--primary", onClick: next }, "再来一封 ✉️"))
      );
    }

    // -----------------------------------------------------------------------
    // 快速笔记
    // -----------------------------------------------------------------------
    function RelatedBlock({ remote, text, wide }) {
      const [state, setState] = React.useState({ loading: true, rel: null });
      const [openPath, setOpenPath] = React.useState(null);
      React.useEffect(() => {
        if (typeof remote.related !== "function") {
          setState({ loading: false, rel: { error: "Host 版本较旧，请重启 DSH" } });
          return;
        }
        let alive = true;
        remote.related({ text }).then(
          (r) => alive && setState({ loading: false, rel: r }),
          (e) => alive && setState({ loading: false, rel: { error: String(e) } })
        );
        return () => {
          alive = false;
        };
      }, [text]);
      if (state.loading) return c(Loading, { text: "正在找相关笔记…" });
      const rel = state.rel;
      if (rel && rel.error) return c("div", { className: "obsbn-error-text" }, rel.error);
      const results = (rel && rel.results) || [];
      if (results.length === 0) return c("div", { className: "obsbn-muted" }, "没有找到明显相关的笔记。");
      const cards = results.map((r) =>
        c(
          "article",
          { key: r.path, className: "obsbn-card" },
          c(
            "div",
            { className: "obsbn-entry-top" },
            c("span", { className: "obsbn-entry-title", title: r.title }, r.title),
            c("span", { className: "obsbn-score" }, r.score != null ? Number(r.score).toFixed(2) : "")
          ),
          c("div", { className: "obsbn-code" }, r.path),
          c("p", { className: "obsbn-summary" }, r.snippet),
          openPath === r.path
            ? c(NoteView, { remote, path: r.path, onClose: () => setOpenPath(null) })
            : c("div", { className: "obsbn-foot" }, c("button", { className: "obsbn-link", onClick: () => setOpenPath(r.path) }, "看原文"))
        )
      );
      return c("div", { className: wide ? "obsbn-grid" : null }, cards);
    }

    function RecentNotes({ remote, tick, wide }) {
      const [state, setState] = React.useState({ loading: true, entries: [] });
      const [openIdx, setOpenIdx] = React.useState(null);
      React.useEffect(() => {
        if (typeof remote.recent !== "function") {
          setState({ loading: false, entries: [] });
          return;
        }
        let alive = true;
        remote.recent().then(
          (r) => alive && setState({ loading: false, entries: (r && r.entries) || [] }),
          () => alive && setState({ loading: false, entries: [] })
        );
        return () => {
          alive = false;
        };
      }, [tick]);
      if (state.loading) return c(Loading, { text: "读取最近记录…" });
      return c(
        "div",
        { className: "obsbn-recent" },
        c(
          "div",
          { className: "obsbn-recent-head" },
          c("span", { className: "obsbn-recent-title" }, "最近记录"),
          c("span", { className: "obsbn-muted" }, state.entries.length > 0 ? "共 " + state.entries.length + " 条" : "")
        ),
        state.entries.length === 0
          ? c("div", { className: "obsbn-muted" }, "还没有快速笔记，保存一条后就会出现在这里。")
          : state.entries.map((e, i) =>
              c(
                "div",
                { key: i, className: "obsbn-recent-item", onClick: () => setOpenIdx(openIdx === i ? null : i) },
                c(
                  "div",
                  { className: "obsbn-recent-top" },
                  c("span", { className: "obsbn-recent-text" }, e.text),
                  c("span", { className: "obsbn-recent-time" }, e.date.slice(5).replace("-", "/") + " " + e.time)
                ),
                openIdx === i
                  ? c(
                      "div",
                      { className: "obsbn-recent-body" },
                      c("div", { className: "obsbn-recent-full" }, e.text),
                      c("div", { className: "obsbn-related-head" }, "与它相关的笔记"),
                      c(RelatedBlock, { remote, text: e.text, wide })
                    )
                  : null
              )
            )
      );
    }

    function QuickTab({ remote, wide }) {
      const [text, setText] = React.useState("");
      const [save, setSave] = React.useState(null);
      const [rel, setRel] = React.useState(null);
      const [busy, setBusy] = React.useState("");
      const [tick, setTick] = React.useState(0);

      const doSave = () => {
        if (!text.trim() || busy) return;
        setBusy("save");
        setSave(null);
        remote.quicknote({ text }).then(
          (r) => {
            setSave(r);
            setBusy("");
            if (!r.error) {
              setText("");
              setTick((t) => t + 1);
            }
          },
          (e) => {
            setSave({ error: String(e) });
            setBusy("");
          }
        );
      };
      const doRel = () => {
        if (text.trim().length < 4 || busy) return;
        setBusy("rel");
        setRel(null);
        remote.related({ text }).then(
          (r) => setRel(r),
          (e) => setRel({ error: String(e) })
        ).then(() => setBusy(""));
      };

      return c(
        "div",
        null,
        c("textarea", {
          className: "obsbn-textarea",
          value: text,
          onChange: (e) => setText(e.target.value),
          placeholder: "随手记一条，保存后追加到今天的日记…",
          "aria-label": "快速笔记内容",
        }),
        c(
          "div",
          { className: "obsbn-actionsrow" },
          c("button", { className: "obsbn-btn obsbn-btn--primary", onClick: doSave, disabled: !!busy }, busy === "save" ? "保存中…" : "保存到今日笔记"),
          c("button", { className: "obsbn-btn obsbn-btn--ghost", onClick: doRel, disabled: !!busy || text.trim().length < 4 }, busy === "rel" ? "找相关…" : "找相关笔记")
        ),
        save && !save.error ? c("div", { className: "obsbn-status obsbn-status--ok" }, "✓ 已追加到 " + save.path) : null,
        save && save.error ? c("div", { className: "obsbn-status obsbn-status--error" }, save.error) : null,
        rel && rel.error ? c("div", { className: "obsbn-error-text", style: { marginBottom: 10 } }, rel.error) : null,
        rel && rel.results && rel.results.length === 0 ? c("div", { className: "obsbn-muted" }, "没有找到明显相关的笔记。") : null,
        rel && rel.results && rel.results.length > 0
          ? c(
              "div",
              { className: "obsbn-sectionhead", style: { marginTop: 14 } },
              c("span", { className: "obsbn-chip" }, "相关笔记"),
              c("span", { className: "obsbn-muted obsbn-grow" }, "共 " + rel.results.length + " 条")
            )
          : null,
        rel && rel.results && rel.results.length > 0 ? c(RelatedBlock, { remote, text: text, wide }) : null,
        c(RecentNotes, { remote, tick, wide })
      );
    }

    // -----------------------------------------------------------------------
    // 面板骨架
    // -----------------------------------------------------------------------
    const TABS = [
      { id: "today", label: "那年今天" },
      { id: "walk", label: "随机漫步" },
      { id: "quick", label: "快速笔记" },
    ];

    class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      render() {
        if (this.state.error) {
          return c(
            "div",
            { className: "obsbn-errorbox" },
            c("div", { className: "obsbn-error-title" }, "小助理渲染出错"),
            c("div", { className: "obsbn-error-text" }, String((this.state.error && this.state.error.message) || this.state.error))
          );
        }
        return this.props.children;
      }
    }

    function Panel({ remote, expanded, onToggleExpand, onClose }) {
      const [tab, setTab] = React.useState("today");
      const wide = !!expanded;

      const header = c(
        "header",
        { className: "obsbn-head" },
        c("div", { className: "obsbn-logo", "aria-hidden": "true" }, c(IconBook, { size: 19 })),
        c(
          "div",
          { className: "obsbn-brand" },
          c("div", { className: "obsbn-name" }, "Obsidian 小助理"),
          c("div", { className: "obsbn-sub" }, formatToday())
        ),
        c(
          "div",
          { className: "obsbn-actions" },
          c(
            "button",
            {
              className: "obsbn-iconbtn",
              onClick: onToggleExpand,
              title: expanded ? "收起为浮窗" : "展开到整页",
              "aria-label": expanded ? "收起为浮窗" : "展开到整页",
            },
            expanded ? c(IconCollapse) : c(IconExpand)
          ),
          c("button", { className: "obsbn-iconbtn", onClick: onClose, title: "关闭", "aria-label": "关闭" }, c(IconClose))
        )
      );

      const tabs = c(
        "nav",
        { className: "obsbn-tabs", role: "tablist", "aria-label": "小助理功能" },
        TABS.map((t) =>
          c(
            "button",
            {
              key: t.id,
              role: "tab",
              "aria-selected": tab === t.id,
              className: "obsbn-tab" + (tab === t.id ? " is-active" : ""),
              onClick: () => setTab(t.id),
            },
            t.label
          )
        )
      );

      const body = c(
        "div",
        { className: "obsbn-body" + (wide ? " obsbn-body--wide" : ""), role: "tabpanel" },
        c(
          Boundary,
          null,
          tab === "today"
            ? c(TodayTab, { remote, wide, onGoQuick: () => setTab("quick") })
            : tab === "walk"
              ? c(WalkTab, { remote, wide })
              : c(QuickTab, { remote, wide })
        )
      );

      const container = c(
        "section",
        {
          className: expanded ? "obsbn-page" : "obsbn-panel",
          role: "dialog",
          "aria-modal": expanded ? "true" : undefined,
          "aria-label": "Obsidian 小助理",
          onClick: (e) => e.stopPropagation(),
        },
        header,
        c(Boundary, null, c(HealthBar, { remote })),
        tabs,
        body
      );

      if (expanded) {
        return c("div", { className: "obsbn-backdrop", onClick: onToggleExpand }, container);
      }
      return c("div", { className: "obsbn-root" }, c("div", { className: "obsbn-floating" }, container));
    }

    function Widget({ remote }) {
      const [open, setOpen] = React.useState(false);
      const [expanded, setExpanded] = React.useState(false);

      React.useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => {
          if (e.key !== "Escape") return;
          if (expanded) setExpanded(false);
          else setOpen(false);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [open, expanded]);

      if (!open) {
        return c(
          Fragment,
          null,
          c(StyleTag),
          c(
            "button",
            {
              className: "obsbn-launcher",
              onClick: () => setOpen(true),
              title: "打开 Obsidian 小助理",
              "aria-label": "打开 Obsidian 小助理",
            },
            c(IconBook, { size: 22 })
          )
        );
      }

      return c(
        Fragment,
        null,
        c(StyleTag),
        c(Panel, {
          remote,
          expanded,
          onToggleExpand: () => setExpanded((v) => !v),
          onClose: () => {
            setOpen(false);
            setExpanded(false);
          },
        })
      );
    }

    function apply(ctx) {
      ctx.inject(["slots"], (scope) => {
        scope.slots.inject("shell.overlay", () =>
          scope.slots.register(
            { name: "shell.overlay", id: "obsidian-assistant", order: 60, label: "Obsidian 小助理" },
            () => c(Widget, { remote: makeRemote(ctx.connection) })
          )
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
