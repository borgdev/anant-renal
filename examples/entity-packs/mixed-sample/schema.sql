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
