// dsh-obsidian-assistant — Client half（手写 __ModuleLoader__ bundle，无需构建步骤）。
window.__ModuleLoader__.load({
  id: "dsh-obsidian-assistant",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");

    // Host 侧 obsbn 服务经 Typert Gateway 的 SRC 通道暴露，但没有编译期
    // Remote 贡献，客户端不会出现 remote.obsbn 服务——改走 connection 的
    // 通用 /api RPC（POST /api/obsbn/<method>），网关按 SRC 声明认领分发。
    const inject = ["connection", "slots"];

    // 参数名即 wire 字段：Host 方法签名 walk(args)/read(args) 等，
    // 所以 payload.args = { args: <业务参数> }；today() 无参传 {}。
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
        related: (a) => call("related", { args: a }),
        read: (a) => call("read", { args: a }),
      };
    }

    const c = React.createElement;
    const tabBtnStyle = {
      flex: 1, padding: "6px 4px", fontSize: 12, border: "none", cursor: "pointer",
      background: "transparent", color: "inherit", opacity: 0.65, fontWeight: 500,
    };
    const btn = {
      padding: "5px 12px", fontSize: 12, cursor: "pointer", borderRadius: 6,
      border: "1px solid rgba(128,128,128,0.4)", background: "transparent", color: "inherit",
    };
    const card = { border: "1px solid rgba(128,128,128,0.25)", borderRadius: 8, padding: "8px 10px", marginBottom: 8 };
    const muted = { fontSize: 11, opacity: 0.55 };

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

    function NoteView({ remote, path, onClose }) {
      const [state, setState] = React.useState({ loading: true, text: "", error: "" });
      React.useEffect(() => {
        let alive = true;
        remote.read({ path }).then(
          (r) => {
            if (!alive) return;
            if (r && r.error) setState({ loading: false, text: "", error: r.error });
            else setState({ loading: false, text: (r && r.text) || "(空)", error: "" });
          },
          (e) => alive && setState({ loading: false, text: "", error: String(e) })
        );
        return () => { alive = false; };
      }, [path]);
      return c("div", { style: Object.assign({}, card, { background: "rgba(128,128,128,0.06)" }) },
        c("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: 4 } },
          c("div", { style: muted }, path),
          c("button", { style: btn, onClick: onClose }, "收起")),
        state.loading
          ? c("div", { style: muted }, "加载中…")
          : state.error
            ? c("div", { style: Object.assign({}, muted, { color: "#c0392b" }) }, state.error)
            : c("pre", { style: { whiteSpace: "pre-wrap", fontSize: 12, margin: 0, maxHeight: 300, overflow: "auto", fontFamily: "inherit" } }, state.text)
      );
    }

    function TodayTab({ remote }) {
      const [state, setState] = React.useState({ loading: true, data: null, error: "", openPath: null });
      React.useEffect(() => {
        let alive = true;
        remote.today().then(
          (r) => {
            if (!alive) return;
            if (r && r.error) setState({ loading: false, data: null, error: r.error, openPath: null });
            else setState({ loading: false, data: r, error: "", openPath: null });
          },
          (e) => alive && setState({ loading: false, data: null, error: String(e), openPath: null })
        );
        return () => { alive = false; };
      }, []);
      if (state.loading) return c("div", { style: muted }, "正在翻找多年前的今天…");
      if (state.error) return c("div", { style: Object.assign({}, muted, { color: "#c0392b" }) }, state.error);
      const entries = (state.data && state.data.entries) || [];
      if (entries.length === 0) return c("div", { style: muted }, "这些年今天的笔记里还没留下内容。今天写点什么吧 → 「快速笔记」");
      return c("div", null,
        c("div", { style: Object.assign({}, muted, { marginBottom: 8 }) }, "共 " + entries.length + " 条 · " + state.data.month + " 月 " + state.data.day + " 日"),
        entries.map((e) =>
          c("div", { key: e.path, style: card },
            c("div", { style: { display: "flex", gap: 6, alignItems: "baseline" } },
              c("span", { style: { fontWeight: 600, fontSize: 12 } }, String(e.year)),
              c("span", { style: Object.assign({}, muted, { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }) }, e.title)),
            c("div", { style: { fontSize: 12.5, margin: "4px 0" } }, e.summary),
            state.openPath === e.path
              ? c(NoteView, { remote, path: e.path, onClose: () => setState((s) => Object.assign({}, s, { openPath: null })) })
              : c("button", { style: Object.assign({}, btn, { padding: "2px 8px", fontSize: 11 }), onClick: () => setState((s) => Object.assign({}, s, { openPath: e.path })) }, "看原文")))
      );
    }

    function WalkTab({ remote }) {
      const [state, setState] = React.useState({ loading: false, data: null, error: "", history: [] });
      const load = () => {
        setState((s) => Object.assign({}, s, { loading: true, error: "" }));
        remote.walk({ exclude: state.history }).then(
          (r) => {
            if (r && r.error) setState((s) => Object.assign({}, s, { loading: false, error: r.error }));
            else
              setState((s) =>
                Object.assign({}, s, {
                  loading: false, data: r, error: "",
                  history: s.history.concat(r ? [r.path] : []).slice(-30),
                })
              );
          },
          (e) => setState((s) => Object.assign({}, s, { loading: false, error: String(e) }))
        );
      };
      React.useEffect(() => { load(); }, []);
      return c("div", null,
        state.loading ? c("div", { style: muted }, "过去正在写信…") : null,
        state.error ? c("div", { style: Object.assign({}, muted, { color: "#c0392b", marginBottom: 8 }) }, state.error) : null,
        state.data
          ? c("div", { style: card },
              c("div", { style: { whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.7 } }, state.data.letter),
              c("div", { style: Object.assign({}, muted, { margin: "8px 0 6px" }) }, "来自：《" + state.data.title + "》 " + state.data.path))
          : null,
        c("div", { style: { display: "flex", gap: 8 } },
          c("button", { style: btn, onClick: load, disabled: state.loading },
            state.loading ? "写信中…" : state.data ? "再来一封 ✉️" : "来一封 ✉️"))
      );
    }

    function QuickTab({ remote }) {
      const [text, setText] = React.useState("");
      const [save, setSave] = React.useState(null);
      const [rel, setRel] = React.useState(null);
      const [busy, setBusy] = React.useState("");
      const [openPath, setOpenPath] = React.useState(null);
      const [tick, setTick] = React.useState(0);
      const doSave = () => {
        if (!text.trim()) return;
        setBusy("save"); setSave(null);
        remote.quicknote({ text }).then(
          (r) => { setSave(r); setBusy(""); if (!r.error) { setText(""); setTick((t) => t + 1); } },
          (e) => { setSave({ error: String(e) }); setBusy(""); }
        );
      };
      const doRel = () => {
        if (text.trim().length < 4) return;
        setBusy("rel"); setRel(null); setOpenPath(null);
        remote.related({ text }).then(
          (r) => setRel(r),
          (e) => setRel({ error: String(e) })
        ).then(() => setBusy(""));
      };
      return c("div", null,
        c("textarea", {
          value: text,
          onChange: (e) => setText(e.target.value),
          placeholder: "随手记一条，保存后追加到今天的日记…",
          style: {
            width: "100%", minHeight: 72, boxSizing: "border-box", padding: 8, fontSize: 13,
            borderRadius: 8, border: "1px solid rgba(128,128,128,0.35)", background: "transparent",
            color: "inherit", fontFamily: "inherit", resize: "vertical",
          },
        }),
        c("div", { style: { display: "flex", gap: 8, margin: "8px 0" } },
          c("button", { style: btn, onClick: doSave, disabled: !!busy }, busy === "save" ? "保存中…" : "保存到今日笔记"),
          c("button", { style: btn, onClick: doRel, disabled: !!busy }, busy === "rel" ? "找相关…" : "找相关笔记")),
        save && !save.error ? c("div", { style: Object.assign({}, muted, { marginBottom: 8 }) }, "✓ 已追加到 " + save.path) : null,
        save && save.error ? c("div", { style: Object.assign({}, muted, { color: "#c0392b", marginBottom: 8 }) }, save.error) : null,
        rel && rel.error ? c("div", { style: Object.assign({}, muted, { color: "#c0392b" }) }, rel.error) : null,
        rel && rel.results && rel.results.length === 0 ? c("div", { style: muted }, "没有找到明显相关的笔记。") : null,
        ((rel && rel.results) || []).map((r) =>
          c("div", { key: r.path, style: card },
            c("div", { style: { display: "flex", gap: 6, alignItems: "baseline" } },
              c("span", { style: { fontSize: 12, fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, r.title),
              c("span", { style: muted }, r.score != null ? Number(r.score).toFixed(2) : "")),
            c("div", { style: Object.assign({}, muted, { margin: "3px 0" }) }, r.path),
            c("div", { style: { fontSize: 12 } }, r.snippet),
            openPath === r.path
              ? c(NoteView, { remote, path: r.path, onClose: () => setOpenPath(null) })
              : c("button", { style: Object.assign({}, btn, { padding: "2px 8px", fontSize: 11, marginTop: 4 }), onClick: () => setOpenPath(r.path) }, "看原文"))),
        c(RecentNotes, { remote, tick })
      );
    }

    function RelatedBlock({ remote, text }) {
      const [state, setState] = React.useState({ loading: true, rel: null });
      const [openPath, setOpenPath] = React.useState(null);
      React.useEffect(() => {
        if (typeof remote.related !== "function") {
          setState({ loading: false, rel: { error: "Host 版本较旧，请重启 dsh web" } });
          return;
        }
        let alive = true;
        remote.related({ text }).then(
          (r) => alive && setState({ loading: false, rel: r }),
          (e) => alive && setState({ loading: false, rel: { error: String(e) } })
        );
        return () => { alive = false; };
      }, [text]);
      if (state.loading) return c("div", { style: muted }, "正在找相关笔记…");
      const rel = state.rel;
      if (rel && rel.error) return c("div", { style: Object.assign({}, muted, { color: "#c0392b" }) }, rel.error);
      const results = (rel && rel.results) || [];
      if (results.length === 0) return c("div", { style: muted }, "没有找到明显相关的笔记。");
      return c("div", null, results.map((r) =>
        c("div", { key: r.path, style: card },
          c("div", { style: { display: "flex", gap: 6, alignItems: "baseline" } },
            c("span", { style: { fontSize: 12, fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, r.title),
            c("span", { style: muted }, r.score != null ? Number(r.score).toFixed(2) : "")),
          c("div", { style: Object.assign({}, muted, { margin: "3px 0" }) }, r.path),
          c("div", { style: { fontSize: 12 } }, r.snippet),
          openPath === r.path
            ? c(NoteView, { remote, path: r.path, onClose: () => setOpenPath(null) })
            : c("button", { style: Object.assign({}, btn, { padding: "2px 8px", fontSize: 11, marginTop: 4 }), onClick: () => setOpenPath(r.path) }, "看原文"))
      ));
    }

    function RecentNotes({ remote, tick }) {
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
        return () => { alive = false; };
      }, [tick]);
      if (state.loading) return c("div", { style: Object.assign({}, muted, { marginTop: 12 }) }, "读取最近记录…");
      if (state.entries.length === 0) return null;
      return c("div", { style: { marginTop: 14, borderTop: "1px solid rgba(128,128,128,0.2)", paddingTop: 10 } },
        c("div", { style: Object.assign({}, muted, { marginBottom: 6 }) }, "最近记录"),
        state.entries.map((e, i) =>
          c("div", { key: i, style: Object.assign({}, card, { marginBottom: openIdx === i ? 8 : 4 }) },
            c("div", {
              onClick: () => setOpenIdx(openIdx === i ? null : i),
              style: { display: "flex", gap: 8, alignItems: "baseline", cursor: "pointer" },
            },
              c("span", { style: { fontSize: 12.5, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                e.text.length > 42 ? e.text.slice(0, 42) + "…" : e.text),
              c("span", { style: muted }, e.date.slice(5) + " " + e.time)),
            openIdx === i
              ? c("div", { style: { marginTop: 6 } },
                  c("div", { style: { fontSize: 12.5, whiteSpace: "pre-wrap", margin: "4px 0 8px", padding: "6px 8px", background: "rgba(128,128,128,0.08)", borderRadius: 6 } }, e.text),
                  c("div", { style: Object.assign({}, muted, { marginBottom: 4 }) }, "与它相关的笔记："),
                  c(RelatedBlock, { remote, text: e.text }))
              : null)
        )
      );
    }

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
          return c("div", { style: Object.assign({}, card, { color: "#c0392b", fontSize: 12 }) },
            "小助理渲染出错：" + String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error));
        }
        return this.props.children;
      }
    }

    function Panel({ remote, onClose }) {
      const [tab, setTab] = React.useState("today");
      return c("div", {
        style: {
          position: "fixed", right: 20, bottom: 20, width: 400, maxWidth: "90vw", maxHeight: "78vh",
          display: "flex", flexDirection: "column", borderRadius: 12, overflow: "hidden",
          background: "var(--background-elevated, #fbfbfd)", color: "inherit",
          border: "1px solid rgba(128,128,128,0.3)", boxShadow: "0 8px 32px rgba(0,0,0,0.25)",
          zIndex: 9999,
        },
      },
        c("div", { style: { display: "flex", alignItems: "center", borderBottom: "1px solid rgba(128,128,128,0.25)", padding: "0 4px 0 12px" } },
          c("div", { style: { fontWeight: 600, fontSize: 13, padding: "10px 0", flex: 1 } }, "Obsidian 小助理"),
          c("button", { style: Object.assign({}, btn, { border: "none", padding: "6px 10px" }), onClick: onClose, title: "收起" }, "×")),
        c("div", { style: { display: "flex", borderBottom: "1px solid rgba(128,128,128,0.25)" } },
          c("button", { style: Object.assign({}, tabBtnStyle, tab === "today" ? { opacity: 1, borderBottom: "2px solid currentColor" } : {}), onClick: () => setTab("today") }, "那年今天"),
          c("button", { style: Object.assign({}, tabBtnStyle, tab === "walk" ? { opacity: 1, borderBottom: "2px solid currentColor" } : {}), onClick: () => setTab("walk") }, "随机漫步"),
          c("button", { style: Object.assign({}, tabBtnStyle, tab === "quick" ? { opacity: 1, borderBottom: "2px solid currentColor" } : {}), onClick: () => setTab("quick") }, "快速笔记")),
        c("div", { style: { padding: 12, overflowY: "auto", flex: 1 } },
          c(Boundary, null,
            tab === "today" ? c(TodayTab, { remote }) : tab === "walk" ? c(WalkTab, { remote }) : c(QuickTab, { remote })))
      );
    }

    function Widget({ remote }) {
      const [open, setOpen] = React.useState(false);
      if (!open)
        return c("button", {
          onClick: () => setOpen(true),
          title: "Obsidian 小助理",
          style: {
            position: "fixed", right: 20, bottom: 20, width: 46, height: 46, borderRadius: "50%",
            cursor: "pointer", fontSize: 20, lineHeight: "46px", textAlign: "center", padding: 0,
            background: "#7c6cf0", color: "#fff", border: "none",
            boxShadow: "0 4px 16px rgba(0,0,0,0.3)", zIndex: 9999,
          },
        }, "📝");
      return c(Panel, { remote, onClose: () => setOpen(false) });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
