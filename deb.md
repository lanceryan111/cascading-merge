下面是处理 venv 这一段的新写法：先检查，不存在就创建，然后统一 `source`。

```bash
        VENV_PATH="${VENV_PATH_IN/#\~/$HOME}"
        if [ -z "$VENV_PATH" ]; then
          echo "::error::venv_path must not be empty"
          exit 1
        fi

        # 1. venv 不存在（或不完整）就创建
        if [ ! -f "$VENV_PATH/bin/activate" ]; then
          SYS_PY="$(command -v python3 || command -v python || true)"
          if [ -z "$SYS_PY" ]; then
            echo "::error::No python3/python found on PATH to create venv"
            exit 1
          fi
          echo "venv not found, creating: $VENV_PATH"
          "$SYS_PY" -m venv "$VENV_PATH"
        else
          echo "Using existing venv: $VENV_PATH"
        fi

        # 2. 激活 venv
        # shellcheck disable=SC1091
        source "$VENV_PATH/bin/activate"
        echo "Python: $(command -v python) ($(python --version 2>&1))"

        # 3. 安装依赖并运行
        cd "$GITHUB_ACTION_PATH"
        python -m pip install -q --disable-pip-version-check -r requirements.txt
        python cascading.py \
          -t "$GH_TOKEN" \
          -r "$REPO" \
          -b "$BRANCH" \
          -d "$DEFAULT_BRANCH" \
          ${RUNNER_DEBUG:+-v}
```

几点说明：

- **判断条件用 `bin/activate` 是否存在**，因为后面要 source 的就是它。如果目录存在但 `activate` 文件缺失（比如上次创建到一半中断了），`python -m venv` 会在原目录里补全，不会报错。
- **激活后用的是裸命令 `python`**，`PATH` 已经指向 venv。中间那行 `echo` 会在日志里打印实际使用的解释器路径，正常应该显示 `.../devops-venv/bin/python`，方便确认确实激活成功。
- **`cd "$GITHUB_ACTION_PATH"` 继续用环境变量**，不能换回 `${{ github.action_path }}`，否则容器 job 又会出现找不到路径的问题。
- 最后那条调用 `cascading.py` 的命令，按你现在脚本实际支持的参数调整。如果还没加 `-e/--exclude`，就不要传 `excluded_branches`。

**两个前提条件不变：**
1. 容器镜像里要有 `python3-venv`，否则创建时会报 `ensurepip is not available`。可以先在镜像里跑一下 `python3 -m venv /tmp/t` 验证。
2. 固定机器上已有的 venv 要和 `venv_path` 的默认值指向同一个路径，否则会在新位置再建一个，而不是复用原来那个。