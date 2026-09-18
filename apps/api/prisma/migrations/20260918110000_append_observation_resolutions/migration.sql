-- Preserve every immutable evaluation, including a later explicit resolution
-- of an automatically captured PARTIAL result. Identical retries are idempotent.
DROP INDEX "run_observation_bindings_attempt_target_contract_observation_key";
CREATE UNIQUE INDEX "run_observation_bindings_resolution_key"
ON "run_observation_bindings"("attempt_id", "target_id", "contract_digest", "observation_id", "binding_digest");
