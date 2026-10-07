我把四张截图里能看到的部分通读了一遍，下面按严重程度列出来。有几处是会直接导致 step 失败的硬问题。

## 1. 第 55–56 行在 `set -e` 下会直接退出（最要命）

```bash
[ -z "$PIP_INDEX_URL" ] && unset PIP_INDEX_URL
```

composite action 里 `shell: bash` 实际展开成 `bash --noprofile --norc -eo pipefail {0}`，带 `-e`。而 `cmd1 && cmd2` 这种 AND-list，当左边失败时整条语句返回非零，`set -e` 就会终止脚本。

你的 `pip_index_url` 默认值是 `https://rp.td.com/...`（非空），所以 `[ -z "$PIP_INDEX_URL" ]` 返回 1 → 整个 step 在第 55 行就挂了，后面的 Python 逻辑根本跑不到。改成逻辑取反，让整条语句恒为 0：

```bash
[ -n "${PIP_INDEX_URL:-}" ]    || unset PIP_INDEX_URL
[ -n "${PIP_TRUSTED_HOST:-}" ] || unset PIP_TRUSTED_HOST
```

## 2. 第 58–62 行的错误提示永远不会打印

```bash
PY_BIN="$(command -v python3 || command -v python)"
if [ -z "$PY_BIN" ]; then ... exit 1; fi
```

同样是 `-e` 的问题：两个 `command -v` 都失败时，命令替换返回非零，赋值语句整体失败，脚本当场退出，那句友好的 "No python3/python found on PATH" 根本没机会输出。末尾补 `|| true`：

```bash
PY_BIN="$(command -v python3 || command -v python || true)"
```

## 3. token 直接拼进命令行（安全 + 注入）

第 81 行 `"$PY_BIN" cascading.py -t ${{ inputs.token }} -r ${{ inputs.repo }} -b ${{ inputs.branch }}` 有两个问题：

- **`${{ }}` 在 `run:` 里是文本替换**，分支名/repo 名里只要有空格、引号、`$(...)`、`;` 就能拼出任意命令。这是 GitHub 官方点名的 script injection 模式，正确做法一律是走 `env:` 再用 `"$VAR"` 引用。
- **token 出现在 argv 里**，在持久化 runner 上同机器的任何进程 `ps aux` 都能看到它（你这个 action 明确支持 persistent runner，所以不是理论风险）。放进 env 传给 Python，让脚本从 `os.environ` 读。

## 4. `excluded_branches` 声明了但没有被使用

你截图里的搜索框显示 `excluded_branches` 在 action.yml 中是 **1 of 1** —— 只有第 16 行的声明本身。也就是说这个 input 从来没传给 `cascading.py`，调用方传了会被静默忽略。确认一下第 81 行（被遮挡的部分）是否漏了对应参数。

## 5. 缺少顶层 `outputs:` 块

从第 35 行直接跳到 `runs:`，中间没有 `outputs:`。composite action 内部 `steps.cascading_merge.outputs.*` 能用（第 85、90、105 行都正常），但**调用方 workflow 拿不到 `pr_number`** —— 必须在 action 级别重新导出：

```yaml
outputs:
  pr_number:
    description: 'Created cascading PR number (empty when nothing to merge)'
    value: ${{ steps.cascading_merge.outputs.pr_number }}
  pr_url:
    description: 'URL of the created PR'
    value: ${{ steps.cascading_merge.outputs.pr_url }}
  source_branch:
    value: ${{ steps.cascading_merge.outputs.source_branch }}
  target_branch:
    value: ${{ steps.cascading_merge.outputs.target_branch }}
```

## 6. 一些次要项

- **第 72–73 行**：`source activate` + `PY_BIN=python` 不如直接 `PY_BIN="$VENV_PATH/bin/python"`，少一层对 PATH 改写的依赖，也避免 `activate` 脚本在 `set -u` 下炸掉。检查项也可以从 `bin/activate` 换成 `-x bin/python`，更贴近实际用途。
- **第 79 行** `cd ${{ github.action_path }}` 没加引号，路径含空格就断。用 `cd "$GITHUB_ACTION_PATH"`。
- **第 40–46 行的 `output` 调试 step** 建议删掉或加 `if: runner.debug == '1'`，每次跑都刷四行噪音。
- **第 98 行** `&& steps.cascading_merge.outputs.pr_number` 靠字符串非空来判真，能用但和第 85 行风格不一致，统一写成 `!= ''` 更明确。
- **持久化 runner 上的共享 venv** 有并发写入风险：两个 job 同时 `pip install` 到同一个 venv 会互相踩。建议调用方加 `concurrency` group，或者 pip 命令加 `--disable-pip-version-check -q` 至少把日志压下去。
- `default_branch`（第 13 行）没写 `required: false`，和其他几个带默认值的 input 风格不统一。

## 改写后的核心 step

```yaml
    - name: Cascading Merge
      id: cascading_merge
      shell: bash
      env:
        PIP_INDEX_URL: ${{ inputs.pip_index_url }}
        PIP_TRUSTED_HOST: ${{ inputs.pip_trusted_host }}
        VENV_PATH_IN: ${{ inputs.venv_path }}
        GH_TOKEN: ${{ inputs.token }}
        REPO: ${{ inputs.repo }}
        BRANCH: ${{ inputs.branch }}
        DEFAULT_BRANCH: ${{ inputs.default_branch }}
        EXCLUDED_BRANCHES: ${{ inputs.excluded_branches }}
      run: |
        # 空值就删掉，让 pip 回落到默认配置（注意不能用 [ -z ] && unset）
        [ -n "${PIP_INDEX_URL:-}" ]    || unset PIP_INDEX_URL
        [ -n "${PIP_TRUSTED_HOST:-}" ] || unset PIP_TRUSTED_HOST

        VENV_PATH="${VENV_PATH_IN/#\~/$HOME}"
        if [ -n "$VENV_PATH" ]; then
          # 持久化 runner：使用调用方提供的虚拟环境
          if [ ! -x "$VENV_PATH/bin/python" ]; then
            echo "::error::venv_path='$VENV_PATH' 下找不到可执行的 bin/python"
            exit 1
          fi
          PY_BIN="$VENV_PATH/bin/python"
        else
          # 临时 runner：直接装依赖，不需要 venv
          echo "No venv_path provided, installing dependencies directly (ephemeral runner)."
          PY_BIN="$(command -v python3 || command -v python || true)"
          if [ -z "$PY_BIN" ]; then
            echo "::error::PATH 上找不到 python3/python"
            exit 1
          fi
        fi

        cd "$GITHUB_ACTION_PATH"
        "$PY_BIN" -m pip install -q --disable-pip-version-check -r requirements.txt
        "$PY_BIN" cascading.py \
          -r "$REPO" \
          -b "$BRANCH" \
          -d "$DEFAULT_BRANCH" \
          -e "$EXCLUDED_BRANCHES"
```

token 走 `GH_TOKEN` 环境变量，让 `cascading.py` 里用 `os.environ["GH_TOKEN"]` 读；`-e` 这个参数名按你 `cascading.py` 里 argparse 的实际定义改。

第 1、2 条是会让 step 直接失败的，建议先验证这两处——你本地跑一下 `bash -e -c '[ -z "x" ] && unset X; echo reached'` 就能看到它不会打印 `reached`。要是你把 `cascading.py` 和完整的第 81 行贴给我，我可以顺带把参数传递和 output 的设置一起对一遍。

新的 action.yml 已经按上一轮的结论整理好，可以直接替换原文件。它需要和改过的 `cascading.py` 一起合入，因为现在 token 改从 `GH_TOKEN` 环境变量读取，并新增了 `-e` 参数。

和原版相比，主要改了这几处：

- **注入风险**：所有 `${{ }}` 都先放进 `env:`，脚本里只引用 `"$VAR"`。job summary 那一步也一样，因为分支名会被直接 echo 出来。
- **新增 `outputs:` 块**：调用方现在能拿到 `pr_number`、`pr_url`、`pr_created`、`source_branch`、`target_branch`。
- **`excluded_branches` 真正传给了脚本**：第 81 行原先漏掉了它。
- **`-v` 不再写死**：只在开启 debug 日志时才加上，调试输出那一步也一样。
- **Python 的选择**：持久化 runner 直接用 `venv/bin/python`，不再 `source activate`。找不到 python 时，报错现在能正常输出。
- **job summary 标题**：按 `pr_created` 区分"新建"和"已存在"两种情况。
- **Auto PR Merge 的条件**：统一写成 `!= ''`。

有一点行为变化需要注意：`cascading.py` 改成在 PR 已存在时也写出 outputs，所以重跑时 Auto PR Merge 也会作用到已有的 PR 上。如果不想要这个效果，在条件里加上 `&& steps.cascading_merge.outputs.pr_created == 'true'` 就行。

另外，`pip_trusted_host` 的描述在截图里被截断了，我按意思补全的，请核对一下措辞。

先更正上一轮的一个错误：**第 1 条（`[ -z ... ] && unset` 会让 step 退出）是我说错了。** bash 的 `set -e` 对 `&&` 链有豁免：只有最后一个 `&&` 之后的命令失败才会触发退出。所以第 55–56 行能正常跑，我给的验证命令其实会打印 `reached`。抱歉。改成 `[ -n ] || unset` 仍然更直观，但这一条不是 bug。第 2 条（`PY_BIN="$(... || command -v python)"` 两个都找不到时，自定义报错不会输出）是成立的，因为赋值语句不在豁免范围内。

下面结合完整的第 81 行和 `cascading.py` 再过一遍。

## action.yml 第 81 行

```
"$PY_BIN" cascading.py -t ${{ inputs.token }} -r ${{ inputs.repo }} -b ${{ inputs.branch }} -d ${{ inputs.default_branch }} -v
```

- **`excluded_branches` 确认是死参数**：这里没传，`cascading.py` 的 argparse 里也没有对应参数。调用方传了也会被忽略，而且不会有任何报错。这是这个 PR 最大的功能缺口，分支名本身就是 `expand-cascade-merge`。
- `-v` 写死了，每次运行都会把全部 release 分支列表打到日志里。可以改成只在开启 debug 时输出：`${RUNNER_DEBUG:+-v}`。
- token 通过 argv 传入、`${{ }}` 没加引号，这两点和上一轮说的一样，仍然建议改。

## cascading.py 的逻辑问题

**1. release 分支的识别和截取不准确（第 93–94、127 行）**

`re.search(r"release/", s)` 是在字符串任意位置匹配，`s.split('/', 2)[-1]` 取的是最后一段。所以：
- `feature/release/foo` 会被当成 release 分支，截出版本号 `foo`；
- `release/1.0/hotfix` 会被截成 `hotfix`，而不是 `1.0/hotfix`。

第 116 行最后拼回 `"release/" + version`，可能得到一个并不存在的目标分支。第 92 行的 `re.sub('release/', '', ...)` 也没有锚定开头。三处都应改为 `startswith` 加 `removeprefix`。

**2. `branch_compare` 返回值不一致，排序结果不确定（第 73–75 行）**

两个分支的 token 逐个比较都相同、但字符串不同时，例如 `1.0` 和 `1-0`，或 `1.01` 和 `1.1`（`int` 后相等），循环会走完并在最后 `return -1`。这样 `compare(a,b)` 和 `compare(b,a)` 都返回 -1，违反了比较函数的约定，`sorted` 的结果取决于输入顺序。最后应该按长度判断：

```python
return -1 if len(tokens_b) > len(tokens_a) else 0
```

另外 `str.isnumeric()` 对 `²`、`½` 这类 Unicode 字符也返回 True，接着 `int()` 会抛异常。建议改用 `tok.isascii() and tok.isdigit()`。

**3. `branch_name_token_prefix` 把 token 直接拼进正则（第 84–88 行）**

token 没有经过 `re.escape`，分支名里出现 `(`、`$`、`^` 这类字符时正则会出错。另外，以分隔符开头的名字（例如 `-foo`）会让 `re.match` 返回 None，`.group()` 直接抛 `AttributeError`。

**4. `sorted_versions.index(curr_branch)` 可能抛 ValueError（第 112 行）**

当前分支没进入 `matched` 时就会抛异常，比如前缀计算不一致，或者以后它被 exclude 掉了。需要先检查，再给出明确的报错或直接退出。

**5. 已有 PR 时不输出任何 outputs（第 162 行起）**

`set_github_output` 只在新建 PR 时调用。如果上一次运行已经建了 PR 但 auto-merge 失败了，重跑时会发现"PR 已存在"，outputs 为空，Auto PR Merge 这一步就永远不会再触发。建议已存在的 PR 也输出 `pr_number`/`pr_url`，再加一个 `pr_created=true/false`。job summary 的标题 "PR Created" 也可以按这个值区分。

**6. 查找已有 PR 是遍历全部 open PR（第 150–157 行）**

被注释掉的第 149 行思路是对的。它当初大概是因为 `head` 必须写成 `owner:branch` 格式才没生效，不是 API 本身不行：

```python
existing = api.pulls.list(state="open", head=f"{owner}:{branch}", base=target_branch)
```

这样一次请求就够了，也顺带解决了 fork 中同名分支被误判的问题。

**7. 次要项**

- `paged(api.repos.list_branches)` 默认每页条数较少，传 `per_page=100` 能减少请求次数。`count` 变量没有用到。
- 第 174–175 行用 `err.msg.split('\n')[2:]` 解析 fastcore 的错误文本，依赖它的格式，版本一升级就可能坏。建议包一层 try，失败时退回 `"No commits between" in str(err)`。
- 第 182–183 行的 `except Exception: raise` 是多余的，可以删掉。
- `exit(0)` 应改为 `sys.exit(0)`。前者来自 `site` 模块，用 `python -S` 运行时不存在。
- `repo.split('/')` 改成 `split('/', 1)` 并解包，格式不对时能直接报错。
- `arg_parser._action_groups.pop()` 用的是私有 API，Python 升级可能失效。

## 建议改法

```python
import fnmatch
import sys

RELEASE_PREFIX = "release/"
SEP = r"[_\-+.]+"

def is_num(tok):
    return tok.isascii() and tok.isdigit()

def tokenize(branch):
    return {'version': branch, 'tokens': re.split(SEP, branch)}

def branch_compare(a, b):
    if a == b:
        return 0
    ta, tb = tokenize(a)['tokens'], tokenize(b)['tokens']
    for i, x in enumerate(ta):
        if i >= len(tb) or not tb[i]:
            return 1
        y = tb[i]
        if is_num(x) and is_num(y):
            if int(x) != int(y):
                return 1 if int(x) > int(y) else -1
        elif is_num(x):
            return 1
        elif is_num(y):
            return -1
        elif x != y:
            return 1 if x > y else -1
    return -1 if len(tb) > len(ta) else 0

def branch_name_token_prefix(branch):
    parts = []
    for tok in tokenize(branch)['tokens']:
        if is_num(tok):
            break
        parts.append(re.escape(tok))
    if not parts:
        return ""
    m = re.match(SEP.join(parts), branch)
    return m.group() if m else ""

def parse_patterns(s):
    return [p.strip() for p in (s or "").split(",") if p.strip()]

def is_excluded(branch, patterns):
    # 支持 "release/1.*" 和 "1.*" 两种写法
    short = branch.removeprefix(RELEASE_PREFIX)
    return any(fnmatch.fnmatchcase(branch, p) or fnmatch.fnmatchcase(short, p)
               for p in patterns)

def determine_target_branch(all_branches, curr_branch, default_branch,
                            excluded=(), verbose=False):
    curr = curr_branch.removeprefix(RELEASE_PREFIX)
    versions = [b[len(RELEASE_PREFIX):] for b in all_branches
                if b.startswith(RELEASE_PREFIX)]
    prefix = branch_name_token_prefix(curr)
    matched = [v for v in versions
               if branch_name_token_prefix(v) == prefix
               and (v == curr or not is_excluded(RELEASE_PREFIX + v, excluded))]
    sorted_versions = sorted(matched, key=cmp_to_key(branch_compare))
    if verbose:
        print(f"prefix: {prefix!r}\nmatched: {sorted_versions}")
    if curr not in sorted_versions:
        raise ValueError(f"{curr_branch} not found among release branches")
    idx = sorted_versions.index(curr)
    if idx + 1 < len(sorted_versions):
        return RELEASE_PREFIX + sorted_versions[idx + 1]
    return default_branch
```

`cascade_pr` 中对应的改动：

```python
def write_pr_outputs(pr, branch, target_branch, created):
    set_github_output("pr_number", str(pr['number']))
    set_github_output("pr_url", pr['html_url'])
    set_github_output("source_branch", branch)
    set_github_output("target_branch", target_branch)
    set_github_output("pr_created", "true" if created else "false")

def cascade_pr(token, repo, branch, default, excluded=(), verbose=False):
    branch = branch.removeprefix("refs/heads/")
    if not branch.startswith(RELEASE_PREFIX):
        print("It's not a release branch. Exit.")
        sys.exit(0)
    if is_excluded(branch, excluded):
        print(f"{branch} matches excluded_branches. Exit.")
        sys.exit(0)

    owner, name = repo.split("/", 1)
    api = GhApi(owner=owner, repo=name, token=token)

    all_branches = [b['name'] for page in paged(api.repos.list_branches, per_page=100)
                    for b in page]
    target_branch = determine_target_branch(all_branches, branch, default,
                                            excluded, verbose=verbose)

    existing = api.pulls.list(state="open", head=f"{owner}:{branch}", base=target_branch)
    if existing:
        if verbose:
            print(f"PR #{existing[0]['number']} already exists")
        write_pr_outputs(existing[0], branch, target_branch, created=False)
        return

    try:
        pr = api.pulls.create(title=f"Cascading changes from {branch} to {target_branch}",
                              body="Automatically created by cascading merge",
                              head=branch, base=target_branch)
    except HTTP422UnprocessableEntityError as err:
        if "No commits between" in str(err):
            print(f"No commits between {target_branch} and {branch}, no PR created.")
            return
        raise
    write_pr_outputs(pr, branch, target_branch, created=True)
```

argparse 部分：

```python
optional.add_argument('-t', '--token', default=os.environ.get('GH_TOKEN'),
                      help='GitHub token (defaults to $GH_TOKEN)')
optional.add_argument('-e', '--exclude', default='',
                      help='Comma-separated glob patterns, e.g. "release/1.*,release/legacy-*"')
args = arg_parser.parse_args()
if not args.token:
    arg_parser.error("token required via -t or GH_TOKEN env")
cascade_pr(args.token, args.repo, args.branch, args.default,
           parse_patterns(args.exclude), args.verbose)
```

对应地，第 81 行改为（配合上一轮的 env 写法）：

```bash
"$PY_BIN" cascading.py -r "$REPO" -b "$BRANCH" -d "$DEFAULT_BRANCH" -e "$EXCLUDED_BRANCHES" ${RUNNER_DEBUG:+-v}
```

## 有两点需要你确认

- **当前分支本身被 exclude 时怎么处理**：上面的写法是直接退出、不建 PR。如果你们希望"被排除的分支仍然往下级联、只是不作为目标"，把 `cascade_pr` 里那段 `is_excluded` 检查删掉即可。`determine_target_branch` 里已经保证当前分支不会被过滤掉。
- `removeprefix` 需要 Python 3.9 及以上。如果持久化 runner 上的 Python 版本更低，改用 `b[len(RELEASE_PREFIX):] if b.startswith(...)`。

`test_cascading.py` 里建议补几个用例：`branch_compare("1.0", "1-0") == 0`、`feature/release/x` 不被当成 release 分支、exclude 跳过中间版本后目标分支顺延、已有 PR 时 outputs 仍被写出。
