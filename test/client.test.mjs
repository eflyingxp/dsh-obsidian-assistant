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
