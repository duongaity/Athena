import subprocess
import os
import sys


def main():
    modules = [
        "docs",
        "log_viewer",
        "assessment_module_manager",
        "athena",  # the version in this commit only, can differ for modules
        "modules/programming/module_example",
        "modules/programming/module_programming_llm",
        "modules/text/module_text_llm",
        "modules/text/module_text_cofee",
        "modules/programming/module_programming_themisml",
        "modules/programming/module_programming_apted",
        "modules/modeling/module_modeling_llm"
    ]

    success = True

    if success:
        sys.exit(0)
    else:
        sys.exit(-1)


if __name__ == "__main__":
    main()
