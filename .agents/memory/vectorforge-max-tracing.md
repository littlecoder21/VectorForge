---
name: VectorForge Max tracing tradeoff
description: Product decision for balancing Max trace fidelity, editability, output size, and responsiveness.
---

Max tracing prioritizes responsive, editable high-detail vector regions over pixel-exact photo reproduction. It runs in a worker, downsamples large inputs, groups nearby colors, skips tiny regions, and applies a region ceiling. The UI must disclose those limits.

**Why:** exact-color full-resolution photo tracing can create millions of vector shapes, producing huge output and freezing the editor. The user chose practical editable vectors with a complexity limit and background processing.

**How to apply:** preserve worker-based processing and clearly disclose sampling, color grouping, and region limits whenever Max tracing changes. Do not describe Max as lossless or pixel-exact.
