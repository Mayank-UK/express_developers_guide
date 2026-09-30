-- 0003 — the sql-depth lab's dataset: a small org chart, three levels deep
-- (CEO → leads → reports), one self-referencing manager FK. Salary is stored
-- as INTEGER cents (never floats — the data-modeling rule, in DDL) and
-- hired_at as a UTC ISO-8601 TEXT stamp. The seed travels WITH the schema:
-- a deterministic dataset in a migration is replayable on every fresh handle.

CREATE TABLE staff (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  manager_id TEXT REFERENCES staff(id),
  salary_cents INTEGER NOT NULL CHECK (salary_cents >= 0),
  department TEXT NOT NULL,
  hired_at TEXT NOT NULL
);

INSERT INTO staff (id, name, manager_id, salary_cents, department, hired_at) VALUES
  ('staff-001', 'Ada Lovelace',      NULL,        25000000, 'executive', '2018-01-15T09:00:00.000Z'),
  ('staff-002', 'Grace Hopper',      'staff-001', 16500000, 'platform',  '2018-03-01T09:00:00.000Z'),
  ('staff-003', 'Edsger Dijkstra',   'staff-001', 15800000, 'data',      '2018-06-11T09:00:00.000Z'),
  ('staff-004', 'Radia Perlman',     'staff-001', 16200000, 'product',   '2019-02-18T09:00:00.000Z'),
  ('staff-005', 'Linus Torvalds',    'staff-002', 12400000, 'platform',  '2019-05-06T09:00:00.000Z'),
  ('staff-006', 'Barbara Liskov',    'staff-002', 13100000, 'platform',  '2020-01-20T09:00:00.000Z'),
  ('staff-007', 'Margaret Hamilton', 'staff-002', 11900000, 'platform',  '2020-09-14T09:00:00.000Z'),
  ('staff-008', 'Claude Shannon',    'staff-003', 11200000, 'data',      '2019-11-04T09:00:00.000Z'),
  ('staff-009', 'E. F. Codd',        'staff-003', 12000000, 'data',      '2021-03-08T09:00:00.000Z'),
  ('staff-010', 'Alan Kay',          'staff-004', 12800000, 'product',   '2020-06-01T09:00:00.000Z'),
  ('staff-011', 'Adele Goldberg',    'staff-004', 11600000, 'product',   '2021-08-23T09:00:00.000Z'),
  ('staff-012', 'Donald Knuth',      'staff-004', 13500000, 'product',   '2022-01-10T09:00:00.000Z');
