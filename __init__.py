from .h3easy import MiniMaxH3EasyExtension

WEB_DIRECTORY = "./web"


async def comfy_entrypoint() -> MiniMaxH3EasyExtension:
    return MiniMaxH3EasyExtension()


__all__ = ["WEB_DIRECTORY", "comfy_entrypoint"]
