import { TRANSFORMERS, type SeedTopic } from '@episteme/application/seed'

/**
 * What the service is composed with for one scene (ADR 0010, decision 8).
 *
 * Only what can vary today is here: the scene's name and the topic it seeds on first start. The domain packs,
 * the dimensions a person may record and the distillation policy still come from `LearnSession` itself, and
 * move here when it is split. Until then a profile names where that dependency will plug in.
 */
export interface SceneProfile {
  readonly name: string
  /** Seeded on first start, before the service accepts a request. Seeding is idempotent. */
  readonly seed: SeedTopic
}

/** The Learn scene, starting from `topic`, or from the transformer demonstration topic. */
export function learnProfile(topic: SeedTopic = TRANSFORMERS): SceneProfile {
  return { name: 'learn', seed: topic }
}
