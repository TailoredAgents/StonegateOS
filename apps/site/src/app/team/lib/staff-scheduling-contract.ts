import { z } from "zod";

export const StaffSchedulingConfigurationSchema = z.object({
  ok: z.literal(true),
  version: z.string().regex(/^[0-9a-f]{64}$/u),
  resources: z.array(z.object({
    id: z.string().uuid(), label: z.string(), kind: z.string(),
    capacityPoolKey: z.string(), capacityUnits: z.number().int().positive(),
    skillKeys: z.array(z.string()), active: z.boolean(), source: z.string(),
  })).max(1000),
  pools: z.array(z.object({ key: z.string(), active: z.boolean(), capacityUnits: z.number().int().nonnegative() })).max(100),
  profiles: z.array(z.object({ id: z.string().uuid(), serviceKey: z.string(), version: z.number().int().positive(), active: z.boolean(), capacityPoolKey: z.string() })).max(1000),
  requirements: z.array(z.object({ id: z.string().uuid(), schedulingProfileId: z.string().uuid(), resourceKind: z.string(), quantity: z.number().int().positive(), capacityUnits: z.number().int().positive(), requiredSkillKeys: z.array(z.string()) })).max(3000),
});

export type StaffSchedulingConfigurationData = z.infer<typeof StaffSchedulingConfigurationSchema>;
