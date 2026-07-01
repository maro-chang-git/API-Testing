// Raised for bad invocation (missing/unknown command or flag, invalid value).
// index.js maps it to exit code 1 (usage error); other errors map to exit 2.
// Lives in its own module so commands don't import the self-executing entry file.
export class UsageError extends Error {}
