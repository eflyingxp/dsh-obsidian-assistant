// obsbn v0.2 客户端 bundle 结构测试：不渲染真实 DOM，只验证 bundle 可加载、
// 工厂能返回 apply/inject、apply 能注册 shell.overlay 组件。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
  Component: class {
    constructor(props) {
      this.props = props;
    }
  },
};

test("client bundle：可加载并导出 apply/inject，apply 注册 shell.overlay", async () => {
  const code = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  let captured = null;
  const fakeWindow = {
    __ModuleLoader__: {
      load: (mod) => {
        captured = mod;
      },
    },
  };
  new Function("window", code)(fakeWindow);
  assert.ok(captured, "应调用 __ModuleLoader__.load");
  assert.equal(captured.id, "dsh-obsidian-assistant");
  assert.equal(typeof captured.factory, "function");

  const module = captured.factory((id) => {
    if (id === "react") return fakeReact;
    throw new Error("未预期的依赖：" + id);
  });
  assert.equal(typeof module.apply, "function");
  assert.deepEqual(module.inject, ["connection", "slots"]);

  let registration = null;
  const scope = {
    slots: {
      inject: (name, factory) => {
        assert.equal(name, "shell.overlay");
        factory();
      },
      register: (options, component) => {
        registration = { options, component };
        return () => {};
      },
    },
  };
  const ctx = {
    connection: { rpc: { call: () => Promise.resolve({ ok: true, value: {} }) } },
    inject: (deps, factory) => {
      assert.ok(Array.isArray(deps) && deps.includes("slots"));
      factory(scope);
    },
  };
  module.apply(ctx);
  assert.ok(registration, "应注册 shell.overlay");
  assert.equal(registration.options.name, "shell.overlay");
  assert.equal(registration.options.id, "obsidian-assistant");
  assert.equal(typeof registration.component, "function");
});

test("client bundle：整页模式、主题 token 与展开/收起按钮已内置", async () => {
  const code = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  for (const marker of [
    "obsbn-backdrop",
    "obsbn-page",
    "obsbn-panel",
    "obsbn-iconbtn",
    "obsbn-launcher",
    "obsbn-textarea",
    "展开到整页",
    "收起为浮窗",
    "--dsw-alias-bg-layer-1",
    "--dsw-alias-brand-primary",
  ]) {
    assert.ok(code.includes(marker), "应包含界面标记：" + marker);
  }
  // 旧版内联定位样式应已移除，样式统一走 CSS 类。
  assert.ok(!code.includes('position: "fixed", right: 20'), "旧版内联浮窗定位应已移除");
  assert.ok(!code.includes("ZIndex 9999"), "旧版内联 z-index 应已移除");
});
