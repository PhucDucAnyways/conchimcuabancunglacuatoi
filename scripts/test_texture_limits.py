import unittest
from PIL import Image
from extract_textures import load_input_image


class ImageLimitsTest(unittest.TestCase):
    def test_large_decoded_image_rejected(self):
        with Image.new('1', (4001, 4000)) as image:
            with self.assertRaisesRegex(ValueError, '16 megapixels'):
                load_input_image(image)

    def test_resize_and_exif_orientation(self):
        with Image.new('RGB', (2000, 1000)) as image:
            image.getexif()[274] = 6
            result, pixels = load_input_image(image)
            self.assertEqual(result.size, (800, 1600))
            self.assertEqual(pixels.shape, (1600, 800, 3))
            result.close()


if __name__ == '__main__':
    unittest.main()
