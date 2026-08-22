export function splitPostgresStatements(source) {
  const sql = String(source ?? "").replace(/\r\n/g, "\n");
  const statements = [];
  let start = 0;
  let index = 0;
  let state = "normal";
  let dollarTag = "";
  let blockCommentDepth = 0;

  const pushStatement = (end) => {
    const statement = sql.slice(start, end).trim();
    if (statement && !/^(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)+$/.test(statement)) {
      statements.push(statement);
    }
  };

  while (index < sql.length) {
    const current = sql[index];
    const next = sql[index + 1] ?? "";

    if (state === "line-comment") {
      if (current === "\n") state = "normal";
      index += 1;
      continue;
    }

    if (state === "block-comment") {
      if (current === "/" && next === "*") {
        blockCommentDepth += 1;
        index += 2;
        continue;
      }
      if (current === "*" && next === "/") {
        blockCommentDepth -= 1;
        index += 2;
        if (blockCommentDepth === 0) state = "normal";
        continue;
      }
      index += 1;
      continue;
    }

    if (state === "single-quote") {
      if (current === "\\") {
        index += Math.min(2, sql.length - index);
        continue;
      }
      if (current === "'" && next === "'") {
        index += 2;
        continue;
      }
      if (current === "'") state = "normal";
      index += 1;
      continue;
    }

    if (state === "double-quote") {
      if (current === '"' && next === '"') {
        index += 2;
        continue;
      }
      if (current === '"') state = "normal";
      index += 1;
      continue;
    }

    if (state === "dollar-quote") {
      if (sql.startsWith(dollarTag, index)) {
        index += dollarTag.length;
        state = "normal";
        continue;
      }
      index += 1;
      continue;
    }

    if (current === "-" && next === "-") {
      state = "line-comment";
      index += 2;
      continue;
    }
    if (current === "/" && next === "*") {
      state = "block-comment";
      blockCommentDepth = 1;
      index += 2;
      continue;
    }
    if (current === "'") {
      state = "single-quote";
      index += 1;
      continue;
    }
    if (current === '"') {
      state = "double-quote";
      index += 1;
      continue;
    }
    if (current === "$") {
      const match = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (match) {
        dollarTag = match[0];
        state = "dollar-quote";
        index += dollarTag.length;
        continue;
      }
    }
    if (current === ";") {
      pushStatement(index);
      start = index + 1;
    }
    index += 1;
  }

  if (state === "single-quote" || state === "double-quote" || state === "dollar-quote" || state === "block-comment") {
    throw new Error(`Unterminated PostgreSQL ${state.replace("-", " ")}.`);
  }

  pushStatement(sql.length);
  return statements;
}
