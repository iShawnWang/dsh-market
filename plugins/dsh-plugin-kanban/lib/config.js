import z from '@deepseek-ai/schemastery';

export const Config = z.object({
  // Empty means "the default under ~/.dsh/kanban". The plugin ships no path of
  // its own so a profile can move the file without editing code.
  dataFile: z.string().default(''),
});
