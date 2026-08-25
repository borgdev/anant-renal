/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to Unison Software Technologies Pvt. Ltd.
 *
 * This source code incorporates proprietary algorithms, software architecture,
 * business logic, computational methods, optimization techniques,
 * workflows, data structures, APIs, and implementation details that are
 * protected by copyright law, patent law, trade secret law, and
 * international intellectual property treaties.
 *
 * Except as expressly permitted by a written license agreement,
 * no person or organization may:
 *
 *   • Copy or reproduce this software.
 *   • Modify or create derivative works.
 *   • Reverse engineer, decompile, or disassemble.
 *   • Benchmark or publicly disclose performance.
 *   • Redistribute, sublicense, lease, rent, or sell.
 *   • Use this software for competitive analysis.
 *   • Disclose any implementation details.
 *
 * Any unauthorized use is strictly prohibited and may result in
 * civil damages, injunctive relief, criminal prosecution,
 * and all other remedies available under applicable law.
 *
 ******************************************************************************/

//! Rich entity populations — deterministic, seeded generation of thousands of entities with
//! human labels and attribute profiles, so a domain reads as real data rather than three
//! hardcoded records. See `docs/ENTERPRISE_DEMO.md` for the enterprise-demo rationale.

use std::collections::HashMap;

/// One generated entity: a stable id, a human label, and an attribute profile used by the
/// query/analytics layer (segment, region, tier, tenure, …).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct EntityProfile {
    pub id: String,
    pub label: String,
    pub attributes: HashMap<String, String>,
    /// Whether this entity runs the full learned-model simulation and is broadcast live.
    /// The bulk population runs baseline-only dynamics server-side (tiered simulation —
    /// `docs/ENTERPRISE_DEMO.md`).
    pub spotlight: bool,
}

impl EntityProfile {
    /// Convenience for hand-authored (showcase) profiles with static attributes.
    pub fn new(id: impl Into<String>, label: impl Into<String>, attributes: &[(&str, &str)], spotlight: bool) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            attributes: attributes
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            spotlight,
        }
    }

    pub fn attribute(&self, key: &str) -> Option<&str> {
        self.attributes.get(key).map(|s| s.as_str())
    }
}

/// A declared entity attribute, so the UI can label and filter by it generically.
#[derive(Clone, Debug, serde::Serialize)]
pub struct AttributeField {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub kind: AttributeKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AttributeKind {
    Text,
    Number,
}

/// One population segment: a label suffix, a count, static attributes, per-entity random
/// pools (region, department, …), and numeric ranges (mrr, tenure, …) for richer profiles.
#[derive(Clone, Debug)]
pub struct SegmentSpec {
    pub label_suffix: &'static str,
    pub count: usize,
    /// Static attributes applied to every entity in the segment.
    pub attributes: Vec<(&'static str, &'static str)>,
    /// Random-pick attribute pools — one value per entity, drawn deterministically.
    pub pools: Vec<(&'static str, &'static [&'static str])>,
    /// Uniform numeric attributes in `[min, max]`, stored as strings.
    pub numeric: Vec<(&'static str, u32, u32)>,
}

/// Full population spec: id prefix, base attributes for every entity, a name-word pool for
/// label generation, and the segments to generate.
#[derive(Clone, Debug)]
pub struct PopulationSpec {
    pub id_prefix: &'static str,
    pub base_attributes: Vec<(&'static str, &'static str)>,
    pub name_words: &'static [&'static str],
    pub segments: Vec<SegmentSpec>,
}

/// Tiny deterministic PRNG (xorshift64* style) — no external RNG dependency, and every
/// restart with the same seed reproduces the same population (idempotent demos).
struct DeterministicRng(u64);

impl DeterministicRng {
    fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n.max(1) as u64) as usize
    }
}

/// Generates the full population for a domain deterministically from `seed`. The first
/// `spotlight_per_segment` entities of each segment are marked as spotlight (full model +
/// live broadcast), so the spotlight set is spread across segments rather than clustered.
/// `scale` multiplies every segment count — used by the server to seed larger record sets
/// (e.g. `POPULATION_SCALE=10`) while keeping ids/labels deterministic per (seed, scale).
pub fn generate_population(
    spec: &PopulationSpec,
    seed: u64,
    spotlight_per_segment: usize,
    scale: u32,
) -> Vec<EntityProfile> {
    let scale = scale.max(1) as usize;
    let mut rng = DeterministicRng::new(seed);
    let capacity: usize = spec.segments.iter().map(|s| s.count.saturating_mul(scale)).sum();
    let mut profiles = Vec::with_capacity(capacity);

    for segment in &spec.segments {
        for i in 0..segment.count.saturating_mul(scale) {
            let word = spec.name_words[rng.below(spec.name_words.len())];
            let number = rng.below(9000) + 1;
            let label = format!("{word} {number}{}", segment.label_suffix);

            let mut attributes: HashMap<String, String> = spec
                .base_attributes
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
            for (k, v) in &segment.attributes {
                attributes.insert(k.to_string(), v.to_string());
            }
            for (k, options) in &segment.pools {
                attributes.insert(k.to_string(), options[rng.below(options.len())].to_string());
            }
            for (k, min, max) in &segment.numeric {
                let value = min + (rng.below((max - min + 1) as usize) as u32);
                attributes.insert(k.to_string(), value.to_string());
            }

            profiles.push(EntityProfile {
                // 5-digit zero-padded ids keep the generated space structurally disjoint from
                // hand-authored showcase ids (e.g. fraud's "acct-1290"), which are never
                // 5-digit — this is what makes seeding idempotent-safe against UNIQUE (domain_id, id).
                id: format!("{}-{:05}", spec.id_prefix, profiles.len() + 1),
                label,
                attributes,
                spotlight: i < spotlight_per_segment,
            });
        }
    }
    profiles
}
