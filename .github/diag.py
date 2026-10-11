import json, subprocess, sys
Q = [
 "SELECT id, name, datetime(updated_at/1000,'unixepoch') AS upd, instr(meta,'\"racks\"') AS has_racks, instr(meta,'\"kit\"') AS has_kit, substr(json_extract(meta,'$.planner'),1,40) AS planner FROM projects WHERE name LIKE '%Bisher%'",
 "SELECT cat, COUNT(*) AS n, SUM(rack IS NOT NULL) AS with_rack, SUM(site_rack IS NOT NULL) AS site_changed FROM points WHERE project_id IN (SELECT id FROM projects WHERE name LIKE '%Bisher%') AND active = 1 GROUP BY cat",
 "SELECT datetime(at/1000,'unixepoch') AS t, by_name, action, detail FROM log WHERE project_id IN (SELECT id FROM projects WHERE name LIKE '%Bisher%') ORDER BY at DESC LIMIT 12",
]
for q in Q:
    r = subprocess.run(["npx","--yes","wrangler@4","d1","execute","expresstech","--remote","--json","--command",q], capture_output=True, text=True)
    t = r.stdout; i = t.find("[")
    try: rows = json.loads(t[i:])[0]["results"]
    except Exception: rows = [(t + r.stderr)[-400:]]
    for row in rows: print("::notice::" + json.dumps(row).replace("\n"," "))
