class CreateComments < ActiveRecord::Migration[5.2]
  def change
    create_table :comments do |t|
      t.string :username
      t.text :comment, null: false
      t.string :commentType, null: false
      t.belongs_to :article, index: true, null: false
      t.belongs_to :comments, index: true

      t.timestamps
    end
  end
end