import { z } from 'zod';

export const password = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200);

export const signupInput = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid email').max(320),
  password,
});
export type SignupInput = z.infer<typeof signupInput>;

export const loginInput = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginInput>;

export const meResponse = z.object({
  user: z.object({
    id: z.string().uuid(),
    name: z.string(),
    email: z.string(),
    timezone: z.string(),
    emailVerified: z.boolean(),
  }),
  orgs: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      slug: z.string(),
      role: z.enum(['owner', 'admin', 'member']),
    }),
  ),
});
export type MeResponse = z.infer<typeof meResponse>;
