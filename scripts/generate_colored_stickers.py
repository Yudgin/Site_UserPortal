#!/usr/bin/env python3
"""
Generate colored versions of stickers using numpy for fast processing.
Takes grayscale stickers and creates colored versions preserving alpha channel.
"""

from PIL import Image
import numpy as np
import os

# Color options matching STICKER_COLOR_OPTIONS in BoatConfiguratorPage.tsx
COLORS = {
    'red': (255, 0, 0),
    'orange': (255, 107, 0),
    'yellow': (255, 215, 0),
    'green': (0, 204, 0),
    'cyan': (0, 204, 204),
    'blue': (0, 102, 255),
    'purple': (153, 0, 255),
    'pink': (255, 0, 204),
    'white': (255, 255, 255),
    'black': (51, 51, 51),
}

# Sticker locations
STICKER_PATHS = [
    ('public/boat/left/group1', [1, 2, 3, 4, 5, 6, 7, 9, 10, 11]),
    ('public/boat/left/group2', [1, 2, 3, 4, 5, 6, 7, 8, 9]),
    ('public/boat/top', [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16]),
    ('public/boat/back', [1, 2, 3, 4, 5, 6]),
]


def colorize_image_fast(img, target_color):
    """
    Colorize a grayscale image with the target color using numpy.
    Preserves alpha channel and brightness variations.
    """
    # Convert to RGBA numpy array
    img_rgba = img.convert('RGBA')
    arr = np.array(img_rgba, dtype=np.float32)

    # Separate channels
    r, g, b, a = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2], arr[:, :, 3]

    # Calculate brightness (average of RGB)
    brightness = (r + g + b) / 3.0 / 255.0

    # Apply target color with brightness
    tr, tg, tb = target_color
    new_r = np.clip(tr * brightness, 0, 255)
    new_g = np.clip(tg * brightness, 0, 255)
    new_b = np.clip(tb * brightness, 0, 255)

    # Create new array
    new_arr = np.zeros_like(arr, dtype=np.uint8)
    new_arr[:, :, 0] = new_r.astype(np.uint8)
    new_arr[:, :, 1] = new_g.astype(np.uint8)
    new_arr[:, :, 2] = new_b.astype(np.uint8)
    new_arr[:, :, 3] = a.astype(np.uint8)

    return Image.fromarray(new_arr, 'RGBA')


def process_sticker(input_path, output_dir, sticker_num):
    """Process a single sticker and generate all color variants."""
    print(f"  Processing sticker-{sticker_num}.png")

    try:
        img = Image.open(input_path)
    except Exception as e:
        print(f"    Error opening {input_path}: {e}")
        return

    for color_name, color_value in COLORS.items():
        # Create output directory for this color
        color_dir = os.path.join(output_dir, color_name)
        os.makedirs(color_dir, exist_ok=True)

        # Generate colored version
        colored_img = colorize_image_fast(img, color_value)

        # Save
        output_path = os.path.join(color_dir, f'sticker-{sticker_num}.png')
        colored_img.save(output_path, 'PNG', optimize=True)
        print(f"    Created {color_name}/sticker-{sticker_num}.png")

    img.close()


def main():
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    for path, sticker_nums in STICKER_PATHS:
        full_path = os.path.join(base_dir, path)
        print(f"\nProcessing {path}...")

        for num in sticker_nums:
            input_file = os.path.join(full_path, f'sticker-{num}.png')
            if os.path.exists(input_file):
                process_sticker(input_file, full_path, num)
            else:
                print(f"  Warning: {input_file} not found")

    print("\nDone! Colored stickers generated.")


if __name__ == '__main__':
    main()
