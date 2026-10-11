// What the model must answer at the two IQF mapping stages (step E). aiExtract validates every answer against these.
import { z } from 'zod';

export const MAP_RELATIONS = ['covers', 'partly_covers', 'related', 'none'] as const;

/** One judgment per candidate, grouped by external requirement. Codes are the ones given in the input. */
export const MapSchema = z.object({
  results: z.array(z.object({
    requirement: z.string(),
    judgments: z.array(z.object({
      candidate: z.string(),
      relation: z.enum(MAP_RELATIONS),
      reason: z.string().nullish(),
    })),
  })),
});
export type MapAnswer = z.infer<typeof MapSchema>;

export const NEW_ITEM_RELATIONS = ['covers', 'partly_covers', 'related'] as const;

/** A drafted new IQF item and the external requirements it would answer. */
export const NewIqfSchema = z.object({
  items: z.array(z.object({
    parent_code: z.string().nullish(),
    level_label: z.string().nullish(),
    code: z.string().nullish(),
    title: z.string().min(1),
    description: z.string().nullish(),
    reason: z.string().nullish(),
    covers: z.array(z.object({
      requirement: z.string(),
      relation: z.enum(NEW_ITEM_RELATIONS),
      reason: z.string().nullish(),
    })),
  })),
});
export type NewIqfAnswer = z.infer<typeof NewIqfSchema>;
