---
status: draft
period: 2026-09-04
theme: buildchain-v4-rust-wasm-production-authority
doc_type: architecture
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-09-04
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-09-04
  invisible_context: not-claimed
---

# Buildchain v4 Rust/WASM production authority

Buildchain v4 的确定性发布语义由
`crates/buildchain-v4-contracts` 编译出的同一份 WebAssembly artifact 执行。Node
仍是 GitHub Action 和 npm 包的宿主，但只负责 provider SDK、文件系统、凭据、环境变量及
workflow 输入输出等副作用边界。权威契约见
`architecture/v4-rust-wasm-production-authority.json`。

## 分发与调用

`packages/core/buildchain-v4-domain.wasm` 与 JavaScript 一起提交和发布。三个生产 Action
在构建时把完全相同的字节复制到各自 `dist/`；运行时不进入调用方仓库寻找 Rust
源码，也不要求安装 Rust。`packages/core/v4-domain-wasm.js` 从自身相邻路径同步读取
artifact，先核验生成元数据中的 SHA-256，再实例化 WebAssembly 并通过封闭 JSON/bytes
ABI 调用领域操作。

缺失、被篡改、无法实例化、缺少导出、ABI 版本不符、trap 或非法响应都会失败关闭；
不存在 JavaScript 领域算法回退。公共 JavaScript API 保留为薄 facade，调用者无须改成
直接操作 WASM 内存。

## 构建和审计

`pnpm run build:v4-wasm` 使用锁定的 Rust 工具链和 `wasm32-unknown-unknown` target 生成
artifact 与绑定元数据。`pnpm run check:v4-wasm` 在干净临时 target 目录重新构建并逐字节
比较已跟踪 artifact。这个检查不是生产运行时的重复编译：生产只加载已提交字节；检查
用于证明这些字节仍能由当前 Rust 真相源和锁定工具链唯一导出，从而阻止源码、二进制或
生成元数据静默漂移。

受保护的 Verify 在 Linux 完成可复现构建，并在 Linux x64、macOS arm64 和 Windows x64
上用 Node 24 直接加载同一提交中的 artifact。Action bundle 检查同时证明三个 `dist/`
副本与核心 artifact 完全一致。

## 权威边界

Rust/WASM 决定 canonical JSON/content root、release invocation、product publication、
provider journal/readback fold、activation、stable fence、partial-mutation recovery 与
release-tail 的计划、状态转换、重试/readback 和 receipt。Node 执行 Rust 返回的明确
instruction，把 provider observation 或归类后的 provider fault 回送给 Rust，由 Rust
决定下一状态；Node 不写第二套相同领域规则。
