export type { SceneRenderer, SceneOptions, SceneFactory, PushOptions, Anchor } from './types';
export { createCanvas2DRenderer } from './canvas2d';
import { createCanvas2DRenderer } from './canvas2d';
import type { SceneFactory } from './types';

/** The renderer in use. Swap this for the WebGPU factory in Phase 5. */
export const createSceneRenderer: SceneFactory = createCanvas2DRenderer;
