import json, pathlib, statistics
BASE = pathlib.Path(__file__).resolve().parent / 'runs'
# object ids I judged wrong (provenance, status, verification, or constraint violation)
err = {'luna-A-r1': ['c3'], 'luna-A-r2': ['q3', 'c6', 'c8', 'q6'], 'terra-A': ['q1'],
       'luna-B-r1': ['c1', 'c2', 'c4'], 'terra-B': ['c6'], 'luna-B-ctx': []}
alln, errn, ok = [], [], []
for lbl, bad in err.items():
    d = json.loads((BASE / f'{lbl}.last.txt').read_text())
    for o in d['objects']:
        alln.append(o['confidence'])
        (errn if o['id'] in bad else ok).append(o['confidence'])
print('objects total          ', len(alln))
print('mean conf all           %.3f  (min %.2f max %.2f)' % (statistics.mean(alln), min(alln), max(alln)))
print('flagged wrong           %d   mean conf %.3f  (min %.2f)' % (len(errn), statistics.mean(errn), min(errn)))
print('judged fine             %d   mean conf %.3f' % (len(ok), statistics.mean(ok)))
print('fraction conf < 0.85    %.3f' % (sum(1 for c in alln if c < 0.85) / len(alln)))
print('fraction conf < 0.90    %.3f' % (sum(1 for c in alln if c < 0.90) / len(alln)))
