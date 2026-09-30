-- 0004 — the EXPLAIN lab's index: a plain B-tree over salary_cents so the
-- same comparison `WHERE salary_cents > ?` can be shown twice — once able to
-- use this index, once defeated by wrapping the column in an expression
-- (`salary_cents * 12 > ?`), which no index on the bare column can serve.

CREATE INDEX idx_staff_salary_cents ON staff(salary_cents);
