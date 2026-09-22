# 同步资料清单格式 v1

状态：A 端确认，供 B 端资料校验器使用。

## 位置与编码

- 文件名：同步根目录下的 `manifest.json`。
- 编码：UTF-8 JSON。
- `path`：相对同步根目录；禁止绝对路径、`..` 越界和同步冲突副本。
- 推荐文件命名：`<TASK_ID>/<ARTIFACT_ID>-<REVISION>.<EXT>`。

## JSON 形状

```json
{
  "task_id": "TASK-0001",
  "revision": "r1",
  "entries": [
    {
      "artifact_id": "requirements",
      "revision": "r1",
      "path": "TASK-0001/requirements-r1.md",
      "sha256": "<64 lowercase hex chars>",
      "size": 1234,
      "required": true
    }
  ]
}
```

约束：

- `task_id` 必填，必须与当前任务一致。
- 顶层 `revision` 可选，用于描述整个资料包修订版。
- `entries` 必填，可为空数组。
- `artifact_id`、条目 `revision`、`path`、`sha256` 必填。
- `size` 可选，为非负整数；存在时必须与实际字节数一致。
- `required` 可选，默认 `true`。必要附件缺失或尚未同步完成时，整个资料包返回“等待资料”，不得返回部分可用路径。
- SHA-256 不一致、路径越界、任务 ID 不符或冲突副本均拒绝整个资料包。

该格式确认 B 端清单中的现有假设，不要求修改其校验核心；只需固定 `parseManifestJson` 的输入结构。
