--*****************************************************************************
--
--  Copyright (c) 2026 AnantHQ Inc.
--  All Rights Reserved.
--
--  This software is licensed, not sold.
--
--  The contents of this file constitute confidential and proprietary
--  information belonging exclusively to Unison Software Technologies Pvt. Ltd.
--
--  This source code incorporates proprietary algorithms, software architecture,
--  business logic, computational methods, optimization techniques,
--  workflows, data structures, APIs, and implementation details that are
--  protected by copyright law, patent law, trade secret law, and
--  international intellectual property treaties.
--
--  Except as expressly permitted by a written license agreement,
--  no person or organization may:
--
--    • Copy or reproduce this software.
--    • Modify or create derivative works.
--    • Reverse engineer, decompile, or disassemble.
--    • Benchmark or publicly disclose performance.
--    • Redistribute, sublicense, lease, rent, or sell.
--    • Use this software for competitive analysis.
--    • Disclose any implementation details.
--
--  Any unauthorized use is strictly prohibited and may result in
--  civil damages, injunctive relief, criminal prosecution,
--  and all other remedies available under applicable law.
--
-- *****************************************************************************/

-- SQL DDL input path
CREATE TABLE IF NOT EXISTS encounter (
  encounter_id     VARCHAR(64) PRIMARY KEY,
  patient_id       VARCHAR(64) NOT NULL REFERENCES patient(patient_id),
  facility_id      VARCHAR(64) NOT NULL,
  arrival_ts       TIMESTAMP NOT NULL,
  discharge_ts     TIMESTAMP,
  chief_complaint  TEXT
);

CREATE TABLE IF NOT EXISTS medication_order (
  order_id     VARCHAR(64) PRIMARY KEY,
  encounter_id VARCHAR(64) NOT NULL,
  rxnorm_code  VARCHAR(32) NOT NULL,
  dose         VARCHAR(64),
  route        VARCHAR(32),
  frequency    VARCHAR(32),
  ordered_by   VARCHAR(64) NOT NULL,
  FOREIGN KEY (encounter_id) REFERENCES encounter(encounter_id)
);
