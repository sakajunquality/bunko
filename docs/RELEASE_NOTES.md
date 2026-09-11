# v0.6.2

Image asset caching now works when build scratch and the cache are on different filesystems, including job containers with a separately mounted home directory. An EXDEV rename falls back to a complete temporary copy on the destination filesystem before committing the file. Cache verification, executable modes and the default cache location are unchanged.

Base-library advisories distinguish paired GNU and musl Linux addons using their ELF dependencies, corresponding variant-labelled paths and the base's executable loader. An opposite-libc variant with a matching alternative is retained in the image and report but marked `inactive-libc-variant` rather than emitting a missing-library warning. Unpaired or ambiguous variants and genuine missing libraries remain advisory.

Bun support remains >=1.3.13 <1.5. See [release evidence](https://github.com/sakajunquality/bunko/blob/main/docs/validation/v0.6.2.md) and [native addon validation](https://github.com/sakajunquality/bunko/blob/main/docs/validation/native-libc-variants.md) for test scope and publication results.
