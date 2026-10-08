/**
 * 子进程环境变量过滤（B8，A 端 B7 评审 B7-3）。
 *
 * ## 缺陷
 * `core/process.ts` 原样把 `process.env` 交给子进程
 * （`env: spec.env ? { ...process.env, ...spec.env } : process.env`）。
 * 执行器进程的环境里带着 `COORDINATOR_API_TOKEN`，于是**测试子进程、
 * 以及 agent 拉起的任何进程都能直接读到协调器凭据**；
 * 一旦把它打印到 stdout，就顺着「原始输出 → artifact → 上报」这条链外泄。
 * 第 7 节明确要求登录文件与凭据「不提交、不上传、不进入日志」。
 *
 * `adapters/opencode.ts` 的 `NodeOpenCodeProcessRunner` 有同一处问题
 * （完全继承 `process.env`），因此过滤逻辑抽到这里共用。
 *
 * ## 过滤范围的取舍（**刻意不做全量关键字屏蔽**）
 * A 端要求过滤「协调器 Token、Cloudflare/GitHub 写入凭据」，即：
 *
 * | 范围 | 例子 |
 * | --- | --- |
 * | 协调系统自身凭据 | `COORDINATOR_API_TOKEN` |
 * | Cloudflare 写入凭据 | `CLOUDFLARE_API_TOKEN`、`CF_API_KEY` |
 * | GitHub 写入凭据 | `GH_TOKEN`、`GITHUB_TOKEN`、`GITHUB_PAT` |
 * | 包管理器凭据 | `NPM_TOKEN`、`NODE_AUTH_TOKEN` |
 * | 云厂商凭据 | `AWS_ACCESS_KEY_ID`、`AZURE_*`、`GOOGLE_APPLICATION_CREDENTIALS` |
 *
 * **不**做「名字里含 KEY/TOKEN 就删」的全量屏蔽：那样会把 agent 自己
 * 连模型服务要用的 provider 凭据一起删掉，等于用新的故障换掉旧的漏洞。
 * 判定规则见 {@link isSensitiveEnvName}，只覆盖「提供方前缀 + 凭据词」的组合。
 */

/**
 * **精确名单**：无论大小写，命中即过滤。
 *
 * 这些名字没有歧义，且都是「写入型」凭据——泄露即可被用来改动云端资源。
 */
export const SENSITIVE_ENV_NAMES: readonly string[] = [
  // 协调系统自身
  "COORDINATOR_API_TOKEN",
  "COORDINATOR_TOKEN",
  // Cloudflare（可写资源）
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_API_USER_SERVICE_KEY",
  "CLOUDFLARE_GLOBAL_API_KEY",
  "CF_API_TOKEN",
  "CF_API_KEY",
  "CF_TOKEN",
  // GitHub（可写仓库）
  "GH_TOKEN",
  "GH_PAT",
  "GITHUB_TOKEN",
  "GITHUB_PAT",
  "GITHUB_OAUTH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  // 包管理器 / 注册表
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "NPM_CONFIG__AUTH",
];

/** 精确名单的**小写**集合，供 O(1) 判定。 */
const SENSITIVE_ENV_NAME_SET: ReadonlySet<string> = new Set(
  SENSITIVE_ENV_NAMES.map((name) => name.toLowerCase()),
);

/**
 * 「提供方前缀」——只有这些提供方的变量才进入第二步判定。
 *
 * 之所以要前缀而不是纯关键字：`PATH`/`TERM`/`HOME` 这类必需变量必须留下，
 * 而单靠关键字无法把「agent 自己的 provider key」与「云端写入凭据」分开。
 */
const PROVIDER_PREFIX =
  /^(COORDINATOR|CLOUDFLARE|CF_|GITHUB|GH_|NPM_|NODE_AUTH|AWS_|AZURE_|GOOGLE_|GCP_|GCLOUD_|DIGITALOCEAN_|DIGITALOCEAN)/i;

/** 「凭据词」——名字里出现才可能是凭据。 */
const CREDENTIAL_WORD =
  /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|API_KEY|APIKEY|_PAT$|PERSONAL_ACCESS)/i;

/**
 * 该环境变量名是否属于「不得进入子进程」的凭据。
 *
 * 判定顺序：精确名单 → 「提供方前缀 + 凭据词」。
 * 两者都不命中即保留（因此 `PATH`、`APPDATA`、`OPENCODE_MODEL` 等照常可用）。
 */
export function isSensitiveEnvName(name: string): boolean {
  const lower = name.toLowerCase();
  if (SENSITIVE_ENV_NAME_SET.has(lower)) return true;
  return PROVIDER_PREFIX.test(name) && CREDENTIAL_WORD.test(name);
}

/**
 * 构造交给子进程的环境变量表。
 *
 * @param inherited 通常传 `process.env`
 * @param extra     调用方显式注入的变量（同样受过滤约束）
 *
 * 两条语义：
 * 1. **过滤发生在合并之后**：显式注入与继承来的变量一视同仁，
 *    因此不存在「换个入口就能把 token 塞进去」的旁路。
 * 2. **不过滤值**：只按**名字**判定。按值判定需要执行器持有 token 明文，
 *    那会让过滤逻辑本身变成新的泄露点；而名字是确定且可测的。
 */
export function scrubbedChildEnv(
  inherited: Readonly<Record<string, string | undefined>>,
  extra?: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined) continue;
    if (isSensitiveEnvName(name)) continue;
    out[name] = value;
  }
  if (extra) {
    for (const [name, value] of Object.entries(extra)) {
      if (isSensitiveEnvName(name)) continue;
      out[name] = value;
    }
  }
  return out;
}

/** 被过滤掉的环境变量名（用于日志与自检，**只报名字，不报值**）。 */
export function droppedEnvNames(
  inherited: Readonly<Record<string, string | undefined>>,
  extra?: Readonly<Record<string, string>>,
): readonly string[] {
  const names = new Set<string>();
  for (const name of Object.keys(inherited)) {
    if (isSensitiveEnvName(name)) names.add(name);
  }
  for (const name of Object.keys(extra ?? {})) {
    if (isSensitiveEnvName(name)) names.add(name);
  }
  return [...names].sort();
}
