-- Defense-in-depth for the budget hierarchy: docs/ARCHITECTURE.md §3
-- argues cycles are structurally impossible today because there is no
-- API that re-parents an existing budget (a child always names an
-- already-existing parent at creation time). This trigger makes that
-- guarantee hold at the database level too, independent of application
-- code, in case a future migration ever adds a re-parenting operation.
CREATE OR REPLACE FUNCTION prevent_budget_cycle() RETURNS trigger AS $$
DECLARE
  current_id uuid;
  hops int := 0;
BEGIN
  IF NEW.parent_budget_id IS NULL THEN
    RETURN NEW;
  END IF;

  current_id := NEW.parent_budget_id;
  WHILE current_id IS NOT NULL LOOP
    IF current_id = NEW.id THEN
      RAISE EXCEPTION 'budget cycle detected: % would become its own ancestor', NEW.id;
    END IF;
    hops := hops + 1;
    IF hops > 1000 THEN
      RAISE EXCEPTION 'budget ancestor chain exceeds 1000 hops for %; refusing (likely a pre-existing cycle)', NEW.id;
    END IF;
    SELECT parent_budget_id INTO current_id FROM budgets WHERE id = current_id;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prevent_budget_cycle
  BEFORE INSERT OR UPDATE OF parent_budget_id ON budgets
  FOR EACH ROW EXECUTE FUNCTION prevent_budget_cycle();
