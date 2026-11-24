/* Adds "Updated By" to companies and people: the Demeisen person who last saved the record, by name
   (e.g. 'Russell Hart', 'Richard Heath'), or that name plus ' (bulk)' for scripted bulk changes.
   The API sets @crm_updated_by on every write; the insert and update triggers copy it onto the row,
   so it is always the latest writer. Edits made straight in the database (no @crm_updated_by) leave it empty.
   The history tables keep the old value, as for every other column.

   Backfill, done with the update triggers removed so no history rows are added and valid_from is untouched:
   - rows last written by a Demeisen person (changed_by = their email) get that person's name;
   - the bulk load of 24 Nov 2026 (00:13 to 01:00 UTC, by Russell) is marked 'Russell Hart (bulk)'.
   Run as admin, before deploying code that uses it. */
USE crm;

ALTER TABLE company ADD COLUMN updated_by VARCHAR(100) NULL AFTER notes;
ALTER TABLE company_history ADD COLUMN updated_by VARCHAR(100) NULL AFTER notes;
ALTER TABLE person ADD COLUMN updated_by VARCHAR(100) NULL AFTER notes;
ALTER TABLE person_history ADD COLUMN updated_by VARCHAR(100) NULL AFTER notes;

DROP TRIGGER company_bi;
DROP TRIGGER company_bu;
DROP TRIGGER company_bd;
DROP TRIGGER person_bi;
DROP TRIGGER person_bu;
DROP TRIGGER person_bd;

UPDATE company c
    JOIN person s ON s.email = c.changed_by
    JOIN company sc ON sc.company_id = s.company_id AND sc.company_type = 'Demeisen'
    SET c.updated_by = s.name;
UPDATE person p
    JOIN (SELECT s.email, s.name FROM person s JOIN company sc ON sc.company_id = s.company_id AND sc.company_type = 'Demeisen') d
      ON d.email = p.changed_by
    SET p.updated_by = d.name;

UPDATE company SET updated_by = 'Russell Hart (bulk)'
    WHERE changed_by = 'russell.hart@demeisen.co.uk' AND valid_from >= '2026-11-24 00:13:00' AND valid_from < '2026-11-24 01:00:00';
UPDATE person SET updated_by = 'Russell Hart (bulk)'
    WHERE changed_by = 'russell.hart@demeisen.co.uk' AND valid_from >= '2026-11-24 00:13:00' AND valid_from < '2026-11-24 01:00:00';

DELIMITER $$

CREATE TRIGGER company_bi BEFORE INSERT ON company FOR EACH ROW
BEGIN
    SET NEW.changed_by = COALESCE(@crm_user, USER()),
        NEW.updated_by = @crm_updated_by,
        NEW.valid_from = UTC_TIMESTAMP(3),
        NEW.valid_to   = '9999-12-31 23:59:59.999';
END$$

CREATE TRIGGER company_bu BEFORE UPDATE ON company FOR EACH ROW
BEGIN
    INSERT INTO company_history (operation, superseded_by, company_id, company_type, name, investor_type, investment_type, engagement_stage, notes, updated_by, changed_by, valid_from, valid_to)
    VALUES ('UPDATE', COALESCE(@crm_user, USER()), OLD.company_id, OLD.company_type, OLD.name, OLD.investor_type, OLD.investment_type, OLD.engagement_stage, OLD.notes, OLD.updated_by, OLD.changed_by, OLD.valid_from, UTC_TIMESTAMP(3));
    SET NEW.changed_by = COALESCE(@crm_user, USER()),
        NEW.updated_by = @crm_updated_by,
        NEW.valid_from = UTC_TIMESTAMP(3),
        NEW.valid_to   = '9999-12-31 23:59:59.999';
END$$

CREATE TRIGGER company_bd BEFORE DELETE ON company FOR EACH ROW
BEGIN
    INSERT INTO company_history (operation, superseded_by, company_id, company_type, name, investor_type, investment_type, engagement_stage, notes, updated_by, changed_by, valid_from, valid_to)
    VALUES ('DELETE', COALESCE(@crm_user, USER()), OLD.company_id, OLD.company_type, OLD.name, OLD.investor_type, OLD.investment_type, OLD.engagement_stage, OLD.notes, OLD.updated_by, OLD.changed_by, OLD.valid_from, UTC_TIMESTAMP(3));
END$$

CREATE TRIGGER person_bi BEFORE INSERT ON person FOR EACH ROW
BEGIN
    SET NEW.changed_by = COALESCE(@crm_user, USER()),
        NEW.updated_by = @crm_updated_by,
        NEW.valid_from = UTC_TIMESTAMP(3),
        NEW.valid_to   = '9999-12-31 23:59:59.999';
END$$

CREATE TRIGGER person_bu BEFORE UPDATE ON person FOR EACH ROW
BEGIN
    INSERT INTO person_history (operation, superseded_by, person_id, name, email, company_id, title, phone, personal_email, linkedin_url, notes, updated_by, changed_by, valid_from, valid_to)
    VALUES ('UPDATE', COALESCE(@crm_user, USER()), OLD.person_id, OLD.name, OLD.email, OLD.company_id, OLD.title, OLD.phone, OLD.personal_email, OLD.linkedin_url, OLD.notes, OLD.updated_by, OLD.changed_by, OLD.valid_from, UTC_TIMESTAMP(3));
    SET NEW.changed_by = COALESCE(@crm_user, USER()),
        NEW.updated_by = @crm_updated_by,
        NEW.valid_from = UTC_TIMESTAMP(3),
        NEW.valid_to   = '9999-12-31 23:59:59.999';
END$$

CREATE TRIGGER person_bd BEFORE DELETE ON person FOR EACH ROW
BEGIN
    INSERT INTO person_history (operation, superseded_by, person_id, name, email, company_id, title, phone, personal_email, linkedin_url, notes, updated_by, changed_by, valid_from, valid_to)
    VALUES ('DELETE', COALESCE(@crm_user, USER()), OLD.person_id, OLD.name, OLD.email, OLD.company_id, OLD.title, OLD.phone, OLD.personal_email, OLD.linkedin_url, OLD.notes, OLD.updated_by, OLD.changed_by, OLD.valid_from, UTC_TIMESTAMP(3));
END$$

DELIMITER ;

CREATE OR REPLACE VIEW company_versions AS
    SELECT company_id, company_type, name, investor_type, investment_type, engagement_stage, notes, updated_by, changed_by, valid_from, valid_to FROM company
    UNION ALL
    SELECT company_id, company_type, name, investor_type, investment_type, engagement_stage, notes, updated_by, changed_by, valid_from, valid_to FROM company_history;

CREATE OR REPLACE VIEW person_versions AS
    SELECT person_id, name, email, company_id, title, phone, personal_email, linkedin_url, notes, updated_by, changed_by, valid_from, valid_to FROM person
    UNION ALL
    SELECT person_id, name, email, company_id, title, phone, personal_email, linkedin_url, notes, updated_by, changed_by, valid_from, valid_to FROM person_history;
