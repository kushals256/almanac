"""Fixed-seed sample of public datasets → data/public-sample.json (reproducible).
SimpleQA: OpenAI, MIT — https://openaipublic.blob.core.windows.net/simple-evals/simple_qa_test_set.csv
FreshQA: Google/freshllms, Apache-2.0 — https://github.com/freshllms/freshqa (Apr 2026 sheet)
Usage: python3 sample-public.py <simpleqa.csv> <freshqa.csv>"""
import csv, json, random, sys, ast
random.seed(20261112)
sq = list(csv.DictReader(open(sys.argv[1], encoding="utf-8")))
simple = []
for r in random.sample(sq, 30):
    meta = ast.literal_eval(r["metadata"])
    simple.append({"source": "simpleqa", "topic": meta.get("topic"), "q": r["problem"], "gold": [r["answer"]]})
rows = list(csv.reader(open(sys.argv[2], encoding="utf-8", errors="ignore")))
hdr = rows[2]; data = [dict(zip(hdr, r)) for r in rows[3:] if len(r) >= len(hdr) and r[hdr.index("split")] == "TEST"]
answers = lambda r: [r[k] for k in hdr if k.startswith("answer_") and r.get(k)]
fp = [r for r in data if r["false_premise"].upper() == "TRUE"]
stable = [r for r in data if r["false_premise"].upper() == "FALSE" and r["fact_type"] in ("never-changing", "slow-changing") and r["effective_year"] in ("before 2022", "2022", "2023", "2024")]
fresh = [{"source": "freshqa", "kind": "false-premise", "q": r["question"], "gold": answers(r), "fact_type": r["fact_type"]} for r in random.sample(fp, 20)]
fresh += [{"source": "freshqa", "kind": r["fact_type"], "q": r["question"], "gold": answers(r), "fact_type": r["fact_type"]} for r in random.sample(stable, 20)]
json.dump({"simpleqa": simple, "freshqa": fresh}, open("data/public-sample.json", "w"), indent=1, ensure_ascii=False)
print(len(simple), "SimpleQA,", len(fresh), "FreshQA (", len([f for f in fresh if f["kind"] == "false-premise"]), "false-premise)")
