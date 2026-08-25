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

// M17 — Identity module public surface.

export * from './types.js';
export { IdentityRegistry } from './registry.js';
export { beginAuth as beginOidcAuth, handleCallback as handleOidcCallback } from './oidc.js';
export { beginWorkOSSso, handleWorkOSCallback, syncWorkOSDirectory } from './workos-adapter.js';
export { Scim, registerScimToken, revokeScimToken, orgForToken, type ScimUser, type ScimGroup } from './scim.js';
export { createInvite, listInvites, getInvite, revokeInvite, claimInvite, setInviteSecret } from './invites.js';
export { activateBreakGlass, endBreakGlass, reviewBreakGlass, listBreakGlass, activeBreakGlassFor, pendingReviews } from './break-glass.js';
