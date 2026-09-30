-- 0006 — the booking race's contested state: one row of stock. Deliberately
-- NO CHECK (stock >= 0) constraint — the whole lesson is that the naive
-- check-then-act path CAN drive this column to -1, visibly. (A CHECK would
-- just convert the oversell into a 500; the fix is the atomic guarded UPDATE
-- in the write itself, not a constraint screaming afterwards.)

CREATE TABLE inventory (
  item TEXT PRIMARY KEY,
  stock INTEGER NOT NULL
);

INSERT INTO inventory (item, stock) VALUES ('workshop-ticket', 25);
