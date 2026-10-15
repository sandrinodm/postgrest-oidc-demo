-- Sample bookings for a few made-up users, so admins have something to look
-- at. The `user_id` values match the test identities the web app suggests for
-- the local OIDC test server. Only loaded into an empty table, so it never
-- brings back rows you deleted. Not for production.

insert into public.time_off_requests (user_id, user_email, user_name, type_code, start_date, end_date, half_day, reason, status)
select v.user_id, v.user_email, v.user_name, v.type_code, v.start_date, v.end_date, v.half_day,
       v.reason, cast(v.status as public.time_off_status)
from (values
    ('user-alice', 'alice@example.com', 'Alice Martin', 'vacation', current_date + 14, current_date + 18, false, 'Summer trip',        'pending'),
    ('user-alice', 'alice@example.com', 'Alice Martin', 'sick',     current_date - 20, current_date - 19, false, null,                 'approved'),
    ('user-bob',   'bob@example.com',   'Bob Janssens', 'personal', current_date + 3,  current_date + 3,  true,  'Dentist',            'pending'),
    ('user-bob',   'bob@example.com',   'Bob Janssens', 'vacation', current_date + 40, current_date + 51, false, 'Two weeks off',      'approved'),
    ('user-carol', 'carol@acme.test',   'Carol Peeters','parental', current_date + 60, current_date + 150,false, null,                 'pending'),
    ('user-carol', 'carol@acme.test',   'Carol Peeters','unpaid',   current_date - 5,  current_date - 3,  false, 'Moving house',       'rejected')
) as v (user_id, user_email, user_name, type_code, start_date, end_date, half_day, reason, status)
where not exists (select 1 from public.time_off_requests);
