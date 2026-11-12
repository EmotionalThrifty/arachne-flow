import os
import unittest

import helpers

JUNCTION = os.path.join(os.environ.get("HERMES_HOME", ""), "plugins", "arachne-flow", "runtime.py")


def _junction_is_this_checkout() -> bool:
    """The dev junction exists and points at THIS checkout (OS file identity); a clone elsewhere has none."""
    try:
        return os.path.samefile(JUNCTION, os.path.join(helpers.ROOT, "runtime.py"))
    except OSError:
        return False


class RuntimeSharingTest(unittest.TestCase):
    def test_copies_share_ctx_by_real_path(self):
        a = helpers.load_module("runtime.py", "fc_rt_copy_a")
        sentinel = object()
        a.bind(sentinel)
        b = a.find_or_load()
        self.assertIs(b.ctx(), sentinel)

    @unittest.skipUnless(_junction_is_this_checkout(), "dev junction not present or points at another checkout")
    def test_junction_path_resolves_to_same_file(self):
        a = helpers.load_module("runtime.py", "fc_rt_copy_c")
        self.assertTrue(a._same_file(JUNCTION, os.path.join(helpers.ROOT, "runtime.py")))


if __name__ == "__main__":
    unittest.main()
