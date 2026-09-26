import sys, glob, os
from PIL import Image
W, H = int(sys.argv[1]), int(sys.argv[2])
for f in glob.glob('/tmp/shots/*.rgba'):
    im = Image.frombytes('RGBA', (W, H), open(f, 'rb').read()).convert('RGB')
    im.save(f[:-5] + '.png'); os.remove(f)
