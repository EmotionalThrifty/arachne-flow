"""Entry used by scripts/hpy after Hermes' bootstrap has set up sys.path."""
import os
import runpy
import sys

args = sys.argv[1:]
if not args:
    sys.exit("usage: hpy script.py [args] | hpy -m module [args]")
if args[0] == "-m":
    sys.argv = [args[1]] + args[2:]
    runpy.run_module(args[1], run_name="__main__", alter_sys=True)
else:
    script = os.path.abspath(args[0])
    sys.argv = [script] + args[1:]
    sys.path.insert(0, os.path.dirname(script))
    runpy.run_path(script, run_name="__main__")
