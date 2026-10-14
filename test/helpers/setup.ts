// Isolate every git invocation from the developer's own git configuration, so tests
// behave the same everywhere and can never read or write the real ~/.gitconfig.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GIT_AUTHOR_NAME = "Test Author";
process.env.GIT_AUTHOR_EMAIL = "author@example.com";
process.env.GIT_COMMITTER_NAME = "Test Committer";
process.env.GIT_COMMITTER_EMAIL = "committer@example.com";
for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_EDITOR", "GIT_EXTERNAL_DIFF"]) {
  delete process.env[name];
}
