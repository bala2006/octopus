"""Development reload without sharing Windows sockets across event loops."""
import argparse
from pathlib import Path

import uvicorn
from watchfiles import run_process


def serve(port: int) -> None:
    # Each child owns its listening socket and gets Uvicorn's subprocess-capable
    # default loop. Uvicorn's Windows reload supervisor uses a Selector loop and
    # its inherited socket cannot safely be reused by a Proactor after a reload.
    uvicorn.run("app.main:app", host="127.0.0.1", port=port)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    run_process(Path(__file__).parent, target=serve, args=(args.port,))
