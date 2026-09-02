import { z } from 'zod';

export const createCommentInput = z.object({
  body: z.string().trim().min(1, 'Write something').max(20_000),
});
export type CreateCommentInput = z.infer<typeof createCommentInput>;

export const comment = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  authorId: z.string().uuid(),
  authorName: z.string(),
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  editable: z.boolean(),
});
export type Comment = z.infer<typeof comment>;
