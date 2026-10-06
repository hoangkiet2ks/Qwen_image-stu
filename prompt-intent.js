const spec = require('./prompt-intent-spec.json');

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function findIntent(prompt) {
  const normalizedPrompt = normalizeText(prompt);
  const ranked = spec.intents
    .map(intent => {
      const matches = intent.synonyms.filter(term => normalizedPrompt.includes(normalizeText(term)));
      return { intent, matches, score: matches.reduce((sum, match) => sum + normalizeText(match).length, 0) };
    })
    .filter(result => result.score > 0)
    .sort((left, right) => right.score - left.score);

  return ranked[0] || null;
}

function resolvePromptIntent({ prompt, activeFeature = 'edit', targetScope = 'single' }) {
  const rawPrompt = String(prompt || '').trim();
  if (!rawPrompt) {
    return { error: 'Cần có mô tả chỉnh sửa để phân tích.' };
  }

  const scope = targetScope === 'multiple' ? 'multiple' : 'single';
  const scopeRules = scope === 'multiple'
    ? [
        'Apply the requested edit independently to every selected target or disconnected mask island.',
        'Keep each target separate with its own original scale, placement, boundaries, and contact points.',
        'Do not merge targets together, omit a selected target, duplicate a target, or apply the change outside selected areas.'
      ]
    : [
        'Apply the requested edit to one selected target only.',
        'Do not alter, duplicate, remove, or merge any other nearby object or subject.'
      ];

  const match = findIntent(rawPrompt);
  const intent = match?.intent;
  const baseParameters = intent?.parameters || {
    denoise: activeFeature === 'edit' ? 0.7 : 0.55,
    steps: activeFeature === 'reconstruct' ? 6 : 4,
    growMask: activeFeature === 'edit' ? 0 : 6,
    skinToneMatch: activeFeature !== 'edit'
  };
  // Multiple disconnected targets need enough sampling steps to keep their
  // geometry independent. This only changes the recommendation; the user can
  // still change it in the quality controls before submitting.
  const parameters = scope === 'multiple'
    ? {
        ...baseParameters,
        denoise: Math.max(baseParameters.denoise, activeFeature === 'reconstruct' ? 0.62 : 0.58),
        steps: Math.max(baseParameters.steps, 6),
        growMask: Math.max(baseParameters.growMask, 4)
      }
    : baseParameters;
  const expandedPrompt = [
    rawPrompt,
    '',
    ...spec.baseRules,
    ...scopeRules,
    ...(intent?.qualityRules || ['Keep the requested change localized and coherent with the original image.'])
  ].join('\n');

  return {
    intent: intent?.id || 'custom_edit',
    label: intent?.label || 'Chỉnh sửa tùy chỉnh',
    targetScope: scope,
    targetScopeLabel: scope === 'multiple' ? 'Nhiều vật thể' : '1 vật thể',
    confidence: match ? Math.min(0.96, 0.55 + match.score / 60) : 0.25,
    matchedKeywords: match?.matches || [],
    workflow: intent?.workflow || (activeFeature === 'edit' ? 'edit' : 'inpaint'),
    recommendedFeature: intent?.workflow === 'reconstruct'
      ? 'reconstruct'
      : intent?.workflow === 'scene'
        ? 'scene'
        : intent?.workflow === 'inpaint'
          ? 'inpaint'
          : activeFeature,
    parameters,
    expandedPrompt,
    negativePrompt: [
      intent?.negativePrompt || 'different face, changed composition, distorted anatomy, visible seam, halo',
      'visible text, letters, words, caption, logo, watermark, signature, UI overlay',
      scope === 'multiple'
        ? 'merged targets, missing selected target, duplicated target, cross-contamination between targets'
        : 'extra changed object, duplicated target, changed nearby object'
    ].join(', ')
  };
}

module.exports = { resolvePromptIntent, spec };
