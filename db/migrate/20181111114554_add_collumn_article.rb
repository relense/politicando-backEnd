class AddCollumnArticle < ActiveRecord::Migration[5.2]
  def change
    add_column :articles, :source, :string
  end
end
